import type { AccessContext } from "@pegma/authorization-core";
import type {
  DraftArticleDto,
  KnowledgeBaseApplication,
  PrivateSourcesVerifier,
  PublishedArticleDto,
  SearchPublishedArticlesInput,
} from "@pegma/knowledge-base-application";
import { articleKinds } from "@pegma/knowledge-base-contracts";
import { z } from "zod";
import { canonical, fingerprint, snapshot } from "./boundary.js";
import type {
  LearningTargetProduct,
  LearningTargetScope,
} from "./learning-integration-types.js";

/** Structural optional KB background capability. Its opaque handle stays in
 * this one invocation, never in Store. Older partial ports hold new checks. */
export interface LearningPublishedSearchObservations {
  observe(
    access: AccessContext,
    input: SearchPublishedArticlesInput,
  ): Promise<
    | {
        readonly outcome: "complete";
        readonly articles: readonly PublishedArticleDto[];
        readonly scopeState: LearningPublishedSearchScopeState;
        readonly observation: unknown;
      }
    | {
        readonly outcome: "partial" | "unavailable";
        readonly articles: readonly [];
      }
  >;
  confirm(access: AccessContext, observation: unknown): Promise<void>;
  readScope(
    access: AccessContext,
    input: { readonly collectionId: string },
  ): Promise<LearningPublishedSearchScopeState>;
  /** Omission keeps legacy structural ports usable; new create checks hold
   * unless the complete authoring comparison capability is available. */
  readArticle?(
    access: AccessContext,
    input: { readonly articleId: string },
  ): Promise<PublishedArticleDto>;
}
export interface LearningPublishedSearchScopeState {
  readonly collectionId: string;
  readonly generation: number;
  readonly scopeHash: string;
}

const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const scopeStateSchema = z
  .object({
    collectionId: scalar,
    generation: z.number().int().positive(),
    scopeHash: hash,
  })
  .strict();
const applicability = z
  .object({
    productId: scalar,
    productVersion: scalar,
    buildId: scalar,
  })
  .strict();
const scopeSchema = z
  .object({
    version: scalar,
    collectionId: scalar,
    query: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    kind: z.enum(articleKinds),
    applicability,
    limit: z.number().int().min(1).max(5),
    explicitDraftIds: z.array(scalar).max(5),
  })
  .strict();
const publishedRef = z
  .object({
    articleId: scalar,
    revision: z.number().int().positive(),
    contentHash: hash,
    projectionHash: hash,
  })
  .strict();
const draftRef = z
  .object({
    articleId: scalar,
    generation: z.number().int().positive(),
    contentHash: hash,
    projectionHash: hash,
  })
  .strict();
export const learningComparisonSelectionSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    published: z.array(publishedRef).max(5),
    drafts: z.array(draftRef).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.published.map((row) => row.articleId)).size !==
        value.published.length ||
      new Set(value.drafts.map((row) => row.articleId)).size !==
        value.drafts.length ||
      new Set(value.scope.explicitDraftIds).size !==
        value.scope.explicitDraftIds.length ||
      canonical(value.drafts.map((row) => row.articleId).sort()) !==
        canonical([...value.scope.explicitDraftIds].sort()) ||
      value.published.length > value.scope.limit
    )
      context.addIssue({ code: "custom", message: "Invalid comparison scope" });
  });
export type LearningComparisonSelection = z.infer<
  typeof learningComparisonSelectionSchema
>;
export const learningCheckedComparisonSchema = z
  .object({
    selection: learningComparisonSelectionSchema,
    scopeState: scopeStateSchema,
    observedAt: z.string().datetime({ precision: 3 }),
    published: z
      .array(
        publishedRef.extend({
          applicationGeneration: z.number().int().positive(),
        }),
      )
      .max(5),
    drafts: z.array(draftRef.extend({ provenanceHash: hash })).max(5),
    digest: hash,
  })
  .strict()
  .superRefine((value, context) => {
    const published = value.published.map(
      ({ applicationGeneration: _generation, ...ref }) => ref,
    );
    const drafts = value.drafts.map(
      ({ provenanceHash: _provenance, ...ref }) => ref,
    );
    if (
      published.length > value.selection.scope.limit ||
      value.scopeState.collectionId !== value.selection.scope.collectionId ||
      new Set(published.map((row) => row.articleId)).size !==
        published.length ||
      canonical(drafts) !== canonical(value.selection.drafts) ||
      value.selection.published.some(
        (hint) =>
          !published.some((current) => canonical(current) === canonical(hint)),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Invalid checked comparison scope",
      });
  });
export type LearningCheckedComparison = z.infer<
  typeof learningCheckedComparisonSchema
>;
type Projection = Pick<
  PublishedArticleDto,
  "kind" | "title" | "summary" | "content" | "tags" | "applicability"
>;
/** Authored fields only: never provenance, source/evidence/actor or resource IDs. */
export function learningComparisonProjection(value: Projection): Projection {
  return snapshot({
    kind: value.kind,
    title: value.title,
    summary: value.summary,
    content: value.content,
    tags: value.tags,
    applicability: value.applicability,
  });
}
export async function learningPublishedComparisonRef(
  value: PublishedArticleDto,
) {
  return publishedRef.parse({
    articleId: value.articleId,
    revision: value.revision,
    contentHash: value.contentHash,
    projectionHash: await fingerprint(learningComparisonProjection(value)),
  });
}
async function learningDraftComparisonRef(value: DraftArticleDto) {
  return draftRef.parse({
    articleId: value.articleId,
    generation: value.generation,
    contentHash: value.revision.contentHash,
    projectionHash: await fingerprint(
      learningComparisonProjection(value.revision),
    ),
  });
}
export async function learningComparisonSelection(
  scope: LearningTargetScope,
  product: LearningTargetProduct,
  limit: number,
  published: readonly PublishedArticleDto[],
  drafts: readonly DraftArticleDto[],
): Promise<LearningComparisonSelection> {
  return learningComparisonSelectionSchema.parse({
    version: 1,
    scope: {
      version: scope.version,
      collectionId: scope.collectionId,
      query: scope.searchQuery,
      kind: scope.kind,
      applicability: {
        productId: product.productId,
        productVersion: product.version,
        buildId: product.buildId,
      },
      limit,
      explicitDraftIds: scope.explicitDraftIds,
    },
    published: await Promise.all(published.map(learningPublishedComparisonRef)),
    drafts: await Promise.all(drafts.map(learningDraftComparisonRef)),
  });
}

export type LearningComparisonKnowledge = Pick<
  KnowledgeBaseApplication,
  "getDraft"
> &
  Partial<
    Pick<KnowledgeBaseApplication, "getPublishedArticle" | "getProvenance">
  > & {
    readonly publishedSearchObservations?: LearningPublishedSearchObservations;
  };
type Within = <T>(work: () => Promise<T>) => Promise<T>;
function requireComparison(value: unknown): asserts value {
  if (!value) throw new TypeError("Learning comparison unavailable or changed");
}
function matching(
  value: Projection & { readonly collectionId: string },
  selection: LearningComparisonSelection,
) {
  requireComparison(
    value.collectionId === selection.scope.collectionId &&
      articleKinds.includes(value.kind) &&
      canonical(value.applicability) ===
        canonical(selection.scope.applicability),
  );
}
export async function readLearningComparisonScope(
  knowledge: LearningComparisonKnowledge,
  access: AccessContext,
  collectionId: string,
  within: Within,
) {
  const observer = knowledge.publishedSearchObservations;
  requireComparison(typeof observer?.readArticle === "function");
  const value = scopeStateSchema.parse(
    await within(() =>
      observer.readScope(access, {
        collectionId: scalar.parse(collectionId),
      }),
    ),
  );
  requireComparison(value.collectionId === collectionId);
  return value;
}
async function currentDraft(
  knowledge: LearningComparisonKnowledge,
  sources: PrivateSourcesVerifier | undefined,
  access: AccessContext,
  expected: z.infer<typeof draftRef>,
  selection: LearningComparisonSelection,
  within: Within,
) {
  requireComparison(knowledge.getProvenance && sources);
  const draft = snapshot(
    await within(() =>
      knowledge.getDraft(access, { articleId: expected.articleId }),
    ),
  );
  matching(draft.revision, selection);
  requireComparison(
    canonical(await learningDraftComparisonRef(draft)) === canonical(expected),
  );
  const provenance = snapshot(
    await within(() =>
      knowledge.getProvenance!(access, { articleId: expected.articleId }),
    ),
  );
  requireComparison(
    provenance.articleId === draft.articleId &&
      provenance.generation === draft.generation,
  );
  for (const set of [provenance.snapshot, provenance.publishedSnapshot]) {
    if (!set) continue;
    for (const reference of set.references)
      requireComparison(
        (await within(() =>
          sources.canRead({ access, articleId: draft.articleId, reference }),
        )) === true,
      );
  }
  const closing = await within(() =>
    knowledge.getDraft(access, { articleId: expected.articleId }),
  );
  requireComparison(closing.generation === draft.generation);
  return {
    reference: {
      ...expected,
      provenanceHash: await fingerprint(provenance),
    },
    projection: learningComparisonProjection(draft.revision),
  };
}

/** Only actual deferred precompute may call this bounded background capability. */
export async function observeLearningComparison(
  knowledge: LearningComparisonKnowledge,
  sources: PrivateSourcesVerifier | undefined,
  access: AccessContext,
  raw: unknown,
  readObservedAt: () => string,
  within: Within,
) {
  const selection = learningComparisonSelectionSchema.parse(raw);
  const observer = knowledge.publishedSearchObservations;
  requireComparison(typeof observer?.readArticle === "function");
  const observed = await within(() =>
    observer.observe(access, {
      collectionId: selection.scope.collectionId,
      query: selection.scope.query,
      applicability: selection.scope.applicability,
      limit: selection.scope.limit,
    }),
  );
  requireComparison(observed.outcome === "complete");
  const observedAt = readObservedAt();
  const scopeState = scopeStateSchema.parse(observed.scopeState);
  requireComparison(scopeState.collectionId === selection.scope.collectionId);
  // Copy data synchronously, but retain the opaque same-instance handle itself.
  const articles = snapshot(observed.articles);
  requireComparison(articles.length <= selection.scope.limit);
  const published = [];
  for (const article of articles) {
    const draft = await within(() =>
      knowledge.getDraft(access, { articleId: article.articleId }),
    );
    const closing = await within(() =>
      observer.readArticle!(access, { articleId: article.articleId }),
    );
    const ref = await learningPublishedComparisonRef(article);
    requireComparison(
      draft.articleId === article.articleId &&
        canonical(await learningPublishedComparisonRef(closing)) ===
          canonical(ref),
    );
    published.push({ ...ref, applicationGeneration: draft.generation });
  }
  requireComparison(
    new Set(published.map((r) => r.articleId)).size === published.length,
  );
  for (const article of articles) matching(article, selection);
  for (const hint of selection.published)
    requireComparison(
      published.some(
        ({ applicationGeneration: _generation, ...current }) =>
          canonical(current) === canonical(hint),
      ),
    );
  const drafts = [];
  for (const ref of selection.drafts)
    drafts.push(
      await currentDraft(knowledge, sources, access, ref, selection, within),
    );
  const value = {
    selection,
    scopeState,
    observedAt,
    published,
    drafts: drafts.map((row) => row.reference),
  };
  const evidence = learningCheckedComparisonSchema.parse({
    ...value,
    digest: await fingerprint(value),
  });
  return {
    evidence,
    projection: {
      scope: {
        coverage: "complete_authorized_search_scope",
        authority: "staff_authoring",
        search: "approved_title_summary_tags_lexical_query",
        query: selection.scope.query,
        applicability: selection.scope.applicability,
        pointInTime: observedAt,
        globalAbsenceClaim: false,
      },
      publishedMatches: articles.map(learningComparisonProjection),
      explicitDrafts: drafts.map((row) => row.projection),
    },
    confirm: (currentAccess: AccessContext) =>
      within(() => observer.confirm(currentAccess, observed.observation)),
  };
}

/** No corpus enumeration: a later check validates only the retained resources.
 * New scope members are evaluated by a subsequent background comparison. */
export async function confirmLearningComparisonResources(
  knowledge: LearningComparisonKnowledge,
  sources: PrivateSourcesVerifier | undefined,
  access: AccessContext,
  raw: unknown,
  within: Within,
  freshScope?: LearningPublishedSearchScopeState,
): Promise<LearningCheckedComparison> {
  const evidence = learningCheckedComparisonSchema.parse(raw);
  const { digest, ...value } = evidence;
  requireComparison((await fingerprint(value)) === digest);
  const selection = evidence.selection;
  const observer = knowledge.publishedSearchObservations;
  requireComparison(typeof observer?.readArticle === "function");
  if (freshScope !== undefined)
    requireComparison(
      canonical(scopeStateSchema.parse(freshScope)) ===
        canonical(evidence.scopeState),
    );
  for (const { applicationGeneration, ...ref } of evidence.published) {
    const article = await within(() =>
      observer.readArticle!(access, { articleId: ref.articleId }),
    );
    matching(article, selection);
    requireComparison(
      canonical(await learningPublishedComparisonRef(article)) ===
        canonical(ref),
    );
    const draft = await within(() =>
      knowledge.getDraft(access, { articleId: ref.articleId }),
    );
    requireComparison(draft.generation === applicationGeneration);
  }
  for (const ref of evidence.drafts) {
    const { provenanceHash, ...expected } = ref;
    const actual = await currentDraft(
      knowledge,
      sources,
      access,
      expected,
      selection,
      within,
    );
    requireComparison(actual.reference.provenanceHash === provenanceHash);
  }
  requireComparison(
    canonical(
      scopeStateSchema.parse(
        // A parallel scope prefetch may finish before proof loading or resource
        // checks. Always close against current collection policy after them.
        await readLearningComparisonScope(
          knowledge,
          access,
          selection.scope.collectionId,
          within,
        ),
      ),
    ) === canonical(evidence.scopeState),
  );
  return evidence;
}
