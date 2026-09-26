export class ClassifierTimeoutError extends Error {
  override readonly name = "ClassifierTimeoutError";

  constructor() {
    super("Classifier request timed out");
  }
}

export class ClassifierUnavailableError extends Error {
  override readonly name = "ClassifierUnavailableError";

  constructor() {
    super("Classifier service is unavailable");
  }
}

export class ClassifierInvalidResponseError extends Error {
  override readonly name = "ClassifierInvalidResponseError";

  constructor() {
    super("Classifier returned an invalid response");
  }
}
