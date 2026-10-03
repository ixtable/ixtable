import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config-store", () => ({
  useDocumentConfig: () => ({
    config: { actions: [], savedQueries: [], reports: [], dashboards: [], design: { forms: [] } },
  }),
}));
vi.mock("../../src/shell/context", () => ({ useShell: () => ({ objects: [] }) }));

const { StepList } = await import("../../src/automation/StepEditor");
type Step = import("../../src/automation/types").Step;

function Harness({ onSteps }: { onSteps: (steps: Step[]) => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  return (
    <StepList
      label="Step"
      actionId="a1"
      steps={steps}
      onChange={(next) => {
        setSteps(next);
        onSteps(next);
      }}
    />
  );
}

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

it("adds a fail step and edits its message expression", async () => {
  const onSteps = vi.fn();
  render(<Harness onSteps={onSteps} />);
  await user.selectOptions(screen.getByLabelText("New step kind"), "fail");
  await user.click(screen.getByRole("button", { name: "Add step" }));
  const step = screen.getByRole("group", { name: /Step 1: Fail with message/ });
  const message = within(step).getByLabelText("Failure message");
  await user.type(message, "'Over the limit'");
  expect(onSteps.mock.lastCall?.[0]).toMatchObject([{ kind: "fail", message: "'Over the limit'" }]);
  expect(within(step).getByLabelText("Only when")).toBeInTheDocument();
});
