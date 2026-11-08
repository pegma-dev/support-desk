import {
  createSupportDeskApplication,
  supportPermissions,
  type EngineeringRepositoryPolicy,
  type PutEngineeringPolicyCommand,
} from "@pegma/support-desk-application";
import type { CollectionDefinition, Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import { engineeringPolicyRecords } from "../packages/application/src/engineering-policy.js";
import {
  engineeringAdmin as admin,
  engineeringBarrier,
  engineeringCustomer as customer,
  engineeringFixture,
  engineeringRepositories,
  engineeringService as service,
  engineeringStores,
} from "../test/engineering-fixtures.js";

for (const [name, createStore] of engineeringStores) {
  describe(`repository policy through real Storage Core (${name})`, () => {
    it("defaults to a disabled empty instance policy without writing or requiring engineering processing", async () => {
      const f = engineeringFixture(createStore(), { engineering: undefined });
      const initial = await f.policy();
      expect(initial).toMatchObject({
        generation: 0,
        policy: { enabled: false, repositories: [] },
      });
      expect(initial.policyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual([]);
      expect(
        await f
          .freshApplication({ engineering: { enabled: false } })
          .readRepositoryPolicy(admin),
      ).toEqual(initial);
      expect(await f.app.readRepositoryPolicy(service)).toEqual(initial);
      await f.create();
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages,
      ).toHaveLength(1);
    });

    it("commits policy, Audit, and compact replay acknowledgement together with current immutable repository IDs", async () => {
      const f = engineeringFixture(createStore());
      f.observed.transactions.length = 0;
      const accepted = await f.putPolicy();
      const policy = await f.policy();
      expect(accepted).toEqual({
        generation: 1,
        policyHash: policy.policyHash,
        enabled: true,
      });
      expect(policy.policy.repositories).toEqual(engineeringRepositories);
      expect(
        policy.policy.repositories.every(
          (repository) => repository.publicationMode === "approval_required",
        ),
      ).toBe(true);
      const transactions = f.observed.transactions.filter(
        (trace) => trace.collection === engineeringPolicyRecords.name,
      );
      expect(transactions).toHaveLength(1);
      expect(transactions[0]!.partition).toBe("instance");
      const rows = await f.backing
        .collection(engineeringPolicyRecords)
        .list("instance");
      expect(rows.map((row) => row.kind).sort()).toEqual([
        "audit",
        "engineering_policy",
        "engineering_policy_command",
      ]);
      expect(
        rows.find((row) => row.kind === "engineering_policy_command"),
      ).toMatchObject({ result: accepted });
      expect(
        JSON.stringify(rows.find((row) => row.kind === "audit")),
      ).toContain("support.engineering.policy_changed");
      const current = await f.policy();
      await f.putPolicy({
        repositories: current.policy.repositories.map((repository, index) =>
          index === 0
            ? {
                ...repository,
                owner: "transferred-org",
                name: "renamed-export",
                visibility: "public",
              }
            : repository,
        ),
      });
      expect(await f.policy()).toMatchObject({
        generation: 2,
        policy: {
          repositories: expect.arrayContaining([
            expect.objectContaining({
              repositoryId: engineeringRepositories[0]!.repositoryId,
              owner: "transferred-org",
              name: "renamed-export",
              visibility: "public",
            }),
          ]),
        },
      });
      expect((await f.policy()).policyHash).not.toBe(current.policyHash);
    });

    it("replays historical policy commands without restoring an old head and requires current staff authority", async () => {
      const f = engineeringFixture(createStore());
      const command: PutEngineeringPolicyCommand = {
        ...f.policyCommand("stable-policy-command"),
        expectedGeneration: 0,
        policy: { enabled: true, repositories: engineeringRepositories },
      };
      const first = await f.app.putRepositoryPolicy(admin, command);
      await f.putPolicy({ repositories: [engineeringRepositories[1]!] });
      const current = await f.policy();
      const rows = await f.backing
        .collection(engineeringPolicyRecords)
        .list("instance");
      expect(await f.app.putRepositoryPolicy(admin, command)).toEqual(first);
      expect(await f.policy()).toEqual(current);
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual(rows);
      await expect(
        f.app.putRepositoryPolicy(admin, {
          ...command,
          policy: { enabled: false, repositories: command.policy.repositories },
        }),
      ).rejects.toThrow();
      for (const denied of [
        supportPermissions.engineeringPolicyManage,
        supportPermissions.queueRead,
      ])
        await expect(
          f.app.putRepositoryPolicy(
            {
              ...admin,
              permissions: admin.permissions.filter(
                (permission) => permission !== denied,
              ),
            },
            command,
          ),
        ).rejects.toMatchObject({ permission: denied });
      await expect(
        f.app.putRepositoryPolicy(
          { ...admin, principalId: "different-policy-manager" },
          command,
        ),
      ).rejects.toThrow();
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual(rows);
    });

    it.each([
      "automatic publication",
      "duplicate immutable ID",
      "URL repository ID",
      "combined owner/name",
      "duplicate label",
      "unknown credential field",
    ] as const)(
      "rejects %s before writing an instance policy",
      async (invalid) => {
        const f = engineeringFixture(createStore());
        const repository = { ...engineeringRepositories[0]! };
        let repositories: readonly unknown[] = [repository];
        if (invalid === "automatic publication")
          repositories = [{ ...repository, publicationMode: "automatic" }];
        if (invalid === "duplicate immutable ID")
          repositories = [repository, { ...repository, name: "other-name" }];
        if (invalid === "URL repository ID")
          repositories = [
            {
              ...repository,
              repositoryId: "https://github.example.invalid/org/repo",
            },
          ];
        if (invalid === "combined owner/name")
          repositories = [{ ...repository, owner: "org/repo" }];
        if (invalid === "duplicate label")
          repositories = [{ ...repository, allowedLabels: ["bug", "bug"] }];
        if (invalid === "unknown credential field")
          repositories = [
            { ...repository, installationToken: "FORBIDDEN_CREDENTIAL" },
          ];
        await expect(
          f.app.putRepositoryPolicy(admin, {
            ...f.policyCommand("invalid-policy"),
            expectedGeneration: 0,
            policy: {
              enabled: true,
              repositories,
            } as EngineeringRepositoryPolicy,
          }),
        ).rejects.toThrow();
        expect((await f.policy()).generation).toBe(0);
        expect(
          await f.backing.collection(engineeringPolicyRecords).list("instance"),
        ).toEqual([]);
      },
    );

    it("reserves the emergency disable rows when ordinary history is full and makes later disable replay/no-op row-free", async () => {
      const f = engineeringFixture(createStore(), {
        engineeringPolicy: { maxRecords: 5 },
      });
      await f.putPolicy();
      await expect(
        f.putPolicy({ repositories: [engineeringRepositories[0]!] }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "engineering_policy_records",
      });
      const current = await f.policy();
      const command = {
        ...f.policyCommand("emergency-disable"),
        expectedGeneration: current.generation,
      };
      const disabled = await f.app.disableEngineeringExports(admin, command);
      expect(disabled).toMatchObject({
        generation: current.generation + 1,
        enabled: false,
      });
      const rows = await f.backing
        .collection(engineeringPolicyRecords)
        .list("instance");
      expect(rows).toHaveLength(5);
      expect(await f.app.disableEngineeringExports(admin, command)).toEqual(
        disabled,
      );
      expect(
        await f.app.disableEngineeringExports(admin, {
          ...f.policyCommand("already-disabled"),
          expectedGeneration: disabled.generation,
        }),
      ).toEqual(disabled);
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual(rows);
      await expect(f.putPolicy()).rejects.toThrow();
      expect((await f.policy()).policy.enabled).toBe(false);
    });

    it("bounds repositories and the complete double-escaped stored record before accepting a policy", async () => {
      const bounded = engineeringFixture(createStore(), {
        engineeringPolicy: { maxRepositories: 1 },
      });
      await expect(bounded.putPolicy()).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "engineering_policy_repositories",
      });
      const f = engineeringFixture(createStore());
      const repositories = Array.from({ length: 8 }, (_, index) => ({
        ...engineeringRepositories[0]!,
        repositoryId: `large-repository-${index}`,
        responsibilities: "\ud800".repeat(2_000),
        product: "\ud800".repeat(1_000),
        component: "\ud800".repeat(1_000),
        version: "\ud800".repeat(1_000),
      }));
      await expect(f.putPolicy({ repositories })).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "serialized_record",
      });
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual([]);
    });

    it.each(["changed", "failure"] as const)(
      "keeps policy, Audit, and receipt atomic when its transaction has %s",
      async (failure) => {
        const f = engineeringFixture(createStore(), { maxConflictAttempts: 1 });
        f.observed.intercept(async (trace, commit) => {
          if (trace.collection !== engineeringPolicyRecords.name)
            return commit();
          if (failure === "failure")
            throw new Error("Synthetic policy commit failure");
          return { committed: false, reason: "changed" };
        });
        await expect(f.putPolicy()).rejects.toThrow();
        f.observed.intercept(undefined);
        expect(
          await f.backing.collection(engineeringPolicyRecords).list("instance"),
        ).toEqual([]);
        await f.putPolicy();
        expect((await f.policy()).generation).toBe(1);
      },
    );

    it("rejects a stale policy writer after a real concurrent policy CAS", async () => {
      const f = engineeringFixture(createStore());
      await f.putPolicy();
      const current = await f.policy();
      const gate = engineeringBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (!paused && trace.collection === engineeringPolicyRecords.name) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.app
        .putRepositoryPolicy(admin, {
          ...f.policyCommand("racing-policy"),
          expectedGeneration: current.generation,
          policy: {
            ...current.policy,
            repositories: [engineeringRepositories[0]!],
          },
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let winningRows;
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error("Policy did not reach its real CAS barrier");
          }),
        ]);
        await f.freshApplication().putRepositoryPolicy(admin, {
          ...f.policyCommand("winning-policy"),
          expectedGeneration: current.generation,
          policy: {
            ...current.policy,
            repositories: [engineeringRepositories[1]!],
          },
        });
        winningRows = await f.backing
          .collection(engineeringPolicyRecords)
          .list("instance");
      } finally {
        gate.release();
      }
      expect(await pending).toHaveProperty("error");
      f.observed.intercept(undefined);
      expect(
        await f.backing.collection(engineeringPolicyRecords).list("instance"),
      ).toEqual(winningRows);
      expect((await f.policy()).policy.repositories).toEqual([
        engineeringRepositories[1]!,
      ]);
    });

    it("keeps equal repository IDs and their metadata isolated between actual instance stores", async () => {
      const first = engineeringFixture(createStore());
      const second = engineeringFixture(createStore());
      await first.putPolicy();
      expect((await second.policy()).generation).toBe(0);
      await second.putPolicy({
        repositories: [
          {
            ...engineeringRepositories[0]!,
            owner: "separate-instance",
            visibility: "public",
          },
        ],
      });
      expect((await first.policy()).policy.repositories[0]!.owner).toBe(
        "synthetic-org",
      );
      expect((await second.policy()).policy.repositories[0]!.owner).toBe(
        "separate-instance",
      );
      expect((await first.policy()).policyHash).not.toBe(
        (await second.policy()).policyHash,
      );
    });

    it.each(["put", "disable"] as const)(
      "rejects a principal change during a real %s policy-head read and cannot replay the original actor's receipt",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const initialCommand: PutEngineeringPolicyCommand = {
          ...f.policyCommand("original-actor-policy"),
          policy: { enabled: true, repositories: engineeringRepositories },
        };
        await f.app.putRepositoryPolicy(admin, initialCommand);
        const current = await f.policy();
        const before = await f.backing
          .collection(engineeringPolicyRecords)
          .list("instance");
        const gate = engineeringBarrier();
        let paused = false;
        const observed: Store = {
          collection<T>(definition: CollectionDefinition<T>) {
            const target = f.store.collection(definition);
            return new Proxy(target, {
              get(object, property) {
                if (
                  definition.name === engineeringPolicyRecords.name &&
                  property === "getVersioned"
                )
                  return async (key: {
                    readonly partition: string;
                    readonly id: string;
                  }) => {
                    const value = await object.getVersioned(key);
                    if (
                      !paused &&
                      key.partition === "instance" &&
                      key.id === "policy"
                    ) {
                      paused = true;
                      await gate.wait();
                    }
                    return value;
                  };
                const value: unknown = Reflect.get(object, property, object);
                return typeof value === "function" ? value.bind(object) : value;
              },
            });
          },
        };
        const app = createSupportDeskApplication({
          store: observed,
          clock: f.clock,
        });
        const actor = {
          ...admin,
          principalId: admin.principalId,
          permissions: [...admin.permissions],
        };
        const command = f.policyCommand(
          "actor-change-during-policy",
          current.generation,
        );
        const pending = (
          operation === "put"
            ? app.putRepositoryPolicy(actor, {
                ...command,
                policy: {
                  ...current.policy,
                  repositories: [engineeringRepositories[0]!],
                },
              })
            : app.disableEngineeringExports(actor, command)
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await Promise.race([
            gate.reached,
            pending.then(() => {
              throw new Error(
                "Policy mutation did not reach its actual head-read barrier",
              );
            }),
          ]);
          actor.principalId = "changed-policy-actor";
        } finally {
          gate.release();
        }
        expect(await pending).toHaveProperty("error");
        expect(
          await f.backing.collection(engineeringPolicyRecords).list("instance"),
        ).toEqual(before);
        await expect(
          app.putRepositoryPolicy(actor, initialCommand),
        ).rejects.toThrow();
        expect(
          await f.backing.collection(engineeringPolicyRecords).list("instance"),
        ).toEqual(before);
        expect(await f.policy()).toEqual(current);
      },
    );
  });
}
