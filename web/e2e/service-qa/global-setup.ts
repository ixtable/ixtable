import seedE2eUser from "../global-setup";
import { assertLocalStackUp } from "./health";

/** service-qa global setup: health gate, then the deterministic e2e user the UI specs log in with. */
export default async function serviceQaGlobalSetup(): Promise<void> {
  await assertLocalStackUp();
  await seedE2eUser();
}
