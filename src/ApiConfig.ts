// 1. Define the static class
export class ApiConfig {
  // Pre-set mutable variables
  public static llmApiEndpoint: string = "http://127.0.0.1:8080/v1";
  public static llmApiKey: string = "local";

  // Prevent creation of instances
  private constructor() {} 
}
