import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { randomUUID } from "node:crypto";
import { TABLE_PORT } from "./azurite.js";

function azureStore(): Store {
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      connection,
      `aicomposition${randomUUID().replaceAll("-", "")}`,
      { allowInsecureConnection: true },
    ),
  });
}

/** Each backend runs the example's own public-SDK composition unchanged. */
export const aiCompositionStores = [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const;
