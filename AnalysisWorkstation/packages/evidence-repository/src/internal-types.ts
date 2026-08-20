export type CollectionStatus = "complete" | "cancelled" | "failed";
export type FieldCollectorSchemaVersion =
  | "field-collector-session/5"
  | "field-collector-session/6";

export type CaseManifest = {
  schemaVersion: "wafc-analysis-case/1";
  caseId: string;
  name: string;
  createdAtUtc: string;
};
