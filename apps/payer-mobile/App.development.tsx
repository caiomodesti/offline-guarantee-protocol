import { PayerApplication } from "./App";
import { loadDevelopmentSession } from "./src/dev-session";

/**
 * Historical Sprint 7 demonstration entrypoint.
 *
 * Production `index.ts` never imports this module or the embedded fixture.
 */
export default function DevelopmentApp() {
  return <PayerApplication configuredMode="development-fixture" loadDevelopmentRuntime={loadDevelopmentSession} />;
}
