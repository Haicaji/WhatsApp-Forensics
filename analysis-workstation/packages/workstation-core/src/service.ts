import type {
  ChatQuery,
  CreateCaseInput,
  InitializeWorkstationInput,
  InspectUsbSoftwareInput,
  MessageQuery,
  ProvisionUsbInput,
  SearchQuery,
  UpdateUsbSoftwareInput,
} from "@wafc/domain";
import { SqliteEvidenceRepository } from "@wafc/evidence-repository/node";

import {
  WorkstationCatalog,
  type RegisteredAssignment,
} from "./catalog";
import { EvidenceIntakeService } from "./importer";
import {
  ProvisioningService,
  type ProvisionUsbResult,
} from "./provisioning";

export type WorkstationServiceOptions = {
  dataRoot: string;
  provisionerExecutable: string;
  verifierExecutable: string;
  collectorReleaseDirectory: string;
};

export class WorkstationService {
  readonly #catalog: WorkstationCatalog;
  readonly #provisioning: ProvisioningService;
  readonly #intake: EvidenceIntakeService;
  readonly #repositories = new Map<string, SqliteEvidenceRepository>();

  constructor(options: WorkstationServiceOptions) {
    this.#catalog = new WorkstationCatalog(options.dataRoot);
    this.#provisioning = new ProvisioningService({
      catalog: this.#catalog,
      provisionerExecutable: options.provisionerExecutable,
      collectorReleaseDirectory: options.collectorReleaseDirectory,
    });
    this.#intake = new EvidenceIntakeService({
      catalog: this.#catalog,
      verifierExecutable: options.verifierExecutable,
    });
  }

  status() {
    return {
      initialized: this.#provisioning.getWorkstationProfile() !== null,
      profile: this.#provisioning.getWorkstationProfile(),
      cases: this.#catalog.listCases(),
    };
  }

  initializeWorkstation(input: InitializeWorkstationInput) {
    return this.#provisioning.initializeWorkstation(input);
  }

  createCase(input: CreateCaseInput) {
    return this.#catalog.createCase(input);
  }

  listCases() {
    return this.#catalog.listCases();
  }

  listAssignments(caseId: string): RegisteredAssignment[] {
    return this.#catalog.listAssignments(caseId);
  }

  provisionUsb(input: ProvisionUsbInput): Promise<ProvisionUsbResult> {
    return this.#provisioning.provisionUsb(input);
  }

  inspectUsbSoftware(input: InspectUsbSoftwareInput) {
    return this.#provisioning.inspectUsbSoftware(input);
  }

  updateUsbSoftware(input: UpdateUsbSoftwareInput) {
    return this.#provisioning.updateUsbSoftware(input);
  }

  importEvidence(caseId: string, bagPath: string) {
    return this.#intake.importEvidence(caseId, bagPath);
  }

  intakeUsb(caseId: string, usbRoot: string) {
    return this.#intake.intakeUsb(caseId, usbRoot);
  }

  intakeUsbAutomatically(usbRoot: string) {
    return this.#intake.intakeUsbAutomatically(usbRoot);
  }

  async getCaseSummary(caseId: string) {
    return this.#repository(caseId).getCaseSummary();
  }

  async listSources(caseId: string) {
    return this.#repository(caseId).listSources();
  }

  async listChats(caseId: string, query: ChatQuery = {}) {
    return this.#repository(caseId).listChats(query);
  }

  async listMessages(caseId: string, query: MessageQuery) {
    return this.#repository(caseId).listMessages(query);
  }

  async searchMessages(caseId: string, query: SearchQuery) {
    return this.#repository(caseId).searchMessages(query);
  }

  async getIntegrity(caseId: string) {
    return this.#repository(caseId).getIntegrity();
  }

  async getMessageContext(caseId: string, recordId: string, radius: number) {
    return this.#repository(caseId).getMessageContext(recordId, radius);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#repositories.values()].map((repository) => repository.close()),
    );
    this.#repositories.clear();
    this.#catalog.close();
  }

  #repository(caseId: string): SqliteEvidenceRepository {
    let repository = this.#repositories.get(caseId);
    if (!repository) {
      repository = new SqliteEvidenceRepository(
        this.#catalog.caseDatabasePath(caseId),
      );
      this.#repositories.set(caseId, repository);
    }
    return repository;
  }
}
