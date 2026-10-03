import { waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  chooseRelated,
  expectAlert,
  LONG,
  openPage,
  runtimePage,
  startFromTemplate,
  type User,
} from "./golden/journey";

async function openProduct(user: User, name: string) {
  const page = runtimePage();
  await user.click(await within(page).findByRole("row", { name: `Open ${name}` }, LONG));
  return within(page).findByRole("form", { name: "Product" }, LONG);
}

it("Runtime: re-choosing the open page returns to its list; images and relationship labels render", async () => {
  const user = await startFromTemplate("Inventory");
  await openPage(user, "Products");
  const product = await openProduct(user, "BOLT-M8");

  await waitFor(() => {
    const image = within(product).getByRole("img", { name: "Product photo" });
    expect(image.tagName).toBe("IMG");
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  }, LONG);
  expect(within(product).queryByText(/^Asset /)).toBeNull();

  const thresholds = await within(product).findByRole("region", { name: "Reorder thresholds" });
  await within(thresholds).findByRole("cell", { name: "Main warehouse" }, LONG);
  expect(within(thresholds).getByRole("cell", { name: "Downtown store" })).toBeInTheDocument();
  expect(within(thresholds).queryByRole("cell", { name: "1" })).toBeNull();

  await openPage(user, "Products");
  await within(runtimePage()).findByRole("region", { name: "Products" }, LONG);
  expect(within(runtimePage()).queryByRole("form", { name: "Product" })).toBeNull();
  expect(within(runtimePage()).queryByRole("button", { name: "Back" })).toBeNull();

  await openPage(user, "Reorder thresholds");
  const list = await within(runtimePage()).findByRole(
    "region",
    { name: "Reorder thresholds" },
    LONG,
  );
  await within(list).findByRole("row", { name: "Open Hex nut M8" }, LONG);
  expect(within(list).getAllByRole("cell", { name: "Airport store" })).toHaveLength(1);
}, 120_000);

it("Runtime: an action on a just-created record keeps its error, and a refresh keeps its message", async () => {
  const user = await startFromTemplate("Inventory");
  await openPage(user, "Transfers");
  const page = runtimePage();
  await user.click(await within(page).findByRole("button", { name: "New transfer" }, LONG));
  const draft = await within(page).findByRole("form", { name: "New Transfer" }, LONG);
  await chooseRelated(user, draft, "Product", "Step ladder 6ft");
  await chooseRelated(user, draft, "From location", "Main warehouse");
  await chooseRelated(user, draft, "To location", "Downtown store");
  await user.type(within(draft).getByRole("spinbutton", { name: "Quantity" }), "5");
  await user.click(within(draft).getByRole("button", { name: "Create" }));

  const form = await within(page).findByRole("form", { name: "Transfer" }, LONG);
  await user.click(await within(form).findByRole("button", { name: "Post transfer" }, LONG));
  await expectAlert(form, "Not enough stock at the source location: 2 on hand.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expectAlert(form, "Not enough stock at the source location: 2 on hand.");

  await openPage(user, "Transfers");
  await user.click(await within(page).findByRole("row", { name: "Open 1" }, LONG));
  const transfer = await within(page).findByRole("form", { name: "Transfer" }, LONG);
  await user.click(await within(transfer).findByRole("button", { name: "Post transfer" }, LONG));
  await within(transfer).findByDisplayValue("posted", {}, LONG);
  expect(within(transfer).getByRole("status").textContent).toBe("Transfer posted.");
  expect(within(transfer).getByRole("button", { name: "Post transfer" })).toBeDisabled();
}, 120_000);
