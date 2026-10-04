import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { asTauriError } from "../../../src/lib/api";
import { dialogMock } from "../setup";
import {
  chooseRelated,
  errorsOf,
  eventually,
  expectAlert,
  LONG,
  openPage,
  runtimePage,
  savedQuery,
  scalar,
  showList,
  sql,
  startFromTemplate,
  validateDocument,
  withJourney,
} from "./journey";

const APP = "crm";

it("CRM: seeded queries, activity report, and pipeline dashboard show the seed's numbers", async () => {
  await withJourney(APP, "reads", async (journey) => {
    const user = await journey.step("Create CRM from the start screen", () =>
      startFromTemplate("CRM"),
    );
    await journey.step("Validate definitions", async () => {
      journey.check("no error issues", errorsOf(await validateDocument()), []);
    });
    await journey.step("Grouped query: deals by stage", async () => {
      journey.check("all stages", await savedQuery("Deals by stage"), [
        ["Lead", 2, 12000],
        ["Qualified", 2, 40000],
        ["Proposal", 2, 19000],
        ["Negotiation", 2, 48000],
        ["Won", 1, 5000],
        ["Lost", 1, 2000],
      ]);
      journey.check(
        "stage parameter filters",
        await savedQuery("Deals by stage", { stage: "Proposal" }),
        [["Proposal", 2, 19000]],
      );
    });
    await journey.step("Filtered query: open deals over 10,000", async () => {
      const rows = await savedQuery("Open deals", { min_amount: 10000 });
      journey.check(
        "titles by amount",
        rows.map((r) => r[1]),
        ["Patient portal", "Grid analytics", "Fleet tracking", "Factory sensors"],
      );
    });
    await journey.step("Open pipeline totals", async () => {
      const rows = await savedQuery("Open pipeline");
      const total = rows.reduce((sum, r) => sum + Number(r[2]), 0);
      const weighted = rows.reduce((sum, r) => sum + Number(r[3]), 0);
      journey.check("open pipeline and weighted value", [total, weighted], [119000, 56700]);
    });
    await journey.step("Activity report renders page 1 of N with totals", async () => {
      await openPage(user, "Activity report");
      const first = await within(runtimePage()).findByRole(
        "img",
        { name: /^Page 1 of \d+$/ },
        LONG,
      );
      expect(within(first).getByText("Activities by company")).toBeInTheDocument();
      expect(within(first).getByText("Acme Corp")).toBeInTheDocument();
      expect(within(first).getAllByText("3 activities, 1 open").length).toBeGreaterThan(0);
      const pages = Number(first.getAttribute("aria-label")?.split(" of ")[1]);
      for (let page = 1; page < pages; page++)
        await user.click(within(runtimePage()).getByRole("button", { name: "Next page" }));
      const last = await within(runtimePage()).findByRole("img", {
        name: `Page ${pages} of ${pages}`,
      });
      journey.check(
        "report total",
        within(last).queryByText("Total activities: 12") !== null,
        true,
      );
    });
    await journey.step("Pipeline dashboard: KPIs and stage filter", async () => {
      await openPage(user, "Pipeline");
      const page = runtimePage();
      const pipeline = await within(page).findByRole("region", { name: "Open pipeline" }, LONG);
      const count = within(page).getByRole("region", { name: "Open deals" });
      await within(pipeline).findByText("$119,000", {}, LONG);
      await within(count).findByText("8", {}, LONG);
      const table = within(page).getByRole("region", { name: "Open deal list" });
      expect(await within(table).findByText("Patient portal", {}, LONG)).toBeVisible();
      const stage = within(page).getByRole("combobox", { name: "Stage" });
      await within(stage).findByRole("option", { name: "Proposal" }, LONG);
      await user.selectOptions(stage, "Proposal");
      await within(pipeline).findByText("$19,000", {}, LONG);
      journey.check(
        "filtered KPIs",
        [
          within(pipeline).getByText("$19,000").textContent,
          (await within(count).findByText("2", {}, LONG)).textContent,
        ],
        ["$19,000", "2"],
      );
    });
  });
}, 120_000);

it("CRM: Runtime CRUD with master/detail, validation, trigger, action, roles, constraints", async () => {
  await withJourney(APP, "crud", async (journey) => {
    const user = await journey.step("Create CRM from the start screen", () =>
      startFromTemplate("CRM"),
    );
    const page = runtimePage();

    await journey.step("Create a company in the Companies form", async () => {
      await showList(user, "Companies");
      expect(await within(page).findByRole("row", { name: "Open Acme Corp" }, LONG)).toBeVisible();
      await user.click(within(page).getByRole("button", { name: "New company" }));
      const form = await within(page).findByRole("form", { name: "New Company" }, LONG);
      await user.type(within(form).getByRole("textbox", { name: "Name" }), "Wayne Enterprises");
      await user.selectOptions(
        within(form).getByRole("combobox", { name: "Industry" }),
        "Manufacturing",
      );
      await user.type(within(form).getByRole("textbox", { name: "Website" }), "wayne.example");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(
        await within(form).findByText("Enter a web address starting with http:// or https://."),
      ).toBeInTheDocument();
      await user.clear(within(form).getByRole("textbox", { name: "Website" }));
      await user.type(
        within(form).getByRole("textbox", { name: "Website" }),
        "https://wayne.example",
      );
      await user.type(within(form).getByRole("textbox", { name: "City" }), "Gotham");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await within(page).findByRole("form", { name: "Company" }, LONG);
      journey.check(
        "stored company",
        await sql("SELECT name, industry, city FROM companies WHERE id = 6"),
        [["Wayne Enterprises", "Manufacturing", "Gotham"]],
      );
    });

    await journey.step("Add a contact through the master/detail list", async () => {
      const contacts = await within(page).findByRole("region", { name: "Contacts" }, LONG);
      await user.click(await within(contacts).findByRole("button", { name: "Add contacts" }, LONG));
      const form = await within(contacts).findByRole("form", { name: "New Contact" }, LONG);
      expect(within(form).queryByRole("region", { name: "Deals" })).toBeNull();
      await user.type(within(form).getByRole("textbox", { name: "Name" }), "Lucius Fox");
      await user.type(within(form).getByRole("textbox", { name: "Email" }), "lucius-at-wayne");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(
        await within(form).findByText("Enter an email address like name@example.com."),
      ).toBeInTheDocument();
      await user.clear(within(form).getByRole("textbox", { name: "Email" }));
      await user.type(within(form).getByRole("textbox", { name: "Email" }), "lucius@wayne.example");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(await within(contacts).findByRole("cell", { name: "Lucius Fox" }, LONG)).toBeVisible();
      journey.check(
        "contact linked to its company",
        await sql("SELECT company_id, email FROM contacts WHERE name = 'Lucius Fox'"),
        [[6, "lucius@wayne.example"]],
      );
    });

    await journey.step("Add a deal: relationship selectors, validation, sync trigger", async () => {
      const deals = within(page).getByRole("region", { name: "Deals" });
      await user.click(within(deals).getByRole("button", { name: "Add deals" }));
      const form = await within(deals).findByRole("form", { name: "New Deal" }, LONG);
      await user.type(within(form).getByRole("textbox", { name: "Title" }), "Bat signal");
      await chooseRelated(user, form, "Stage", "Proposal");
      await chooseRelated(user, form, "Contact", "Lucius Fox");
      const amount = within(form).getByRole("spinbutton", { name: "Amount" });
      await user.type(amount, "-5");
      await user.tab();
      expect(await within(form).findByText("Amount cannot be negative.")).toBeInTheDocument();
      await user.clear(amount);
      await user.type(amount, "50000");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(await within(deals).findByRole("cell", { name: "Bat signal" }, LONG)).toBeVisible();
      journey.check(
        "stored deal",
        await sql(
          "SELECT d.title, s.name, d.amount, d.status FROM deals d JOIN deal_stages s ON s.id = d.stage_id WHERE d.company_id = 6",
        ),
        [["Bat signal", "Proposal", 50000, "open"]],
      );
      journey.check(
        "the deal trigger logged an activity in the same workflow",
        await sql("SELECT kind, subject, done FROM activities WHERE company_id = 6"),
        [["note", "Deal created: Bat signal", 1]],
      );
    });

    await journey.step("Duplicate company name surfaces the unique constraint", async () => {
      await user.click(within(page).getByRole("button", { name: "Back to Companies" }));
      await user.click(await within(page).findByRole("button", { name: "New company" }, LONG));
      const form = await within(page).findByRole("form", { name: "New Company" }, LONG);
      await user.type(within(form).getByRole("textbox", { name: "Name" }), "Acme Corp");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await expectAlert(form, /Unique constraint failed/);
      journey.check("no duplicate stored", await scalar("SELECT count(*) FROM companies"), 6);
    });

    await journey.step("Check constraint rejects a negative amount written directly", async () => {
      const code = await invoke("insert_row", {
        windowLabel: "main",
        table: "deals",
        values: [
          { column: "company_id", value: { type: "integer", value: 1 } },
          { column: "stage_id", value: { type: "integer", value: 1 } },
          { column: "title", value: { type: "text", value: "Bad" } },
          { column: "amount", value: { type: "real", value: -1 } },
        ],
      })
        .then(() => "OK")
        .catch((reason: unknown) => asTauriError(reason).code);
      journey.check("error code", code, "CONSTRAINT_VIOLATION");
    });

    await journey.step("Mark deal won (transactional action)", async () => {
      await showList(user, "Deals");
      await user.click(await within(page).findByRole("row", { name: "Open Bat signal" }, LONG));
      const deal = await within(page).findByRole("form", { name: "Deal" }, LONG);
      await user.click(await within(deal).findByRole("button", { name: "Mark deal won" }, LONG));
      await eventually(async () =>
        expect(await sql("SELECT status FROM deals WHERE title = 'Bat signal'")).toEqual([["won"]]),
      );
      journey.check(
        "stage, close date, and won activity",
        await sql(
          "SELECT s.name, d.close_date IS NOT NULL, (SELECT count(*) FROM activities a WHERE a.deal_id = d.id AND a.subject = 'Deal won: Bat signal') FROM deals d JOIN deal_stages s ON s.id = d.stage_id WHERE d.title = 'Bat signal'",
        ),
        [["Won", true, 1]],
      );
    });

    await journey.step("Edit a contact and delete it from the related list", async () => {
      await showList(user, "Companies");
      await user.click(
        await within(page).findByRole("row", { name: "Open Wayne Enterprises" }, LONG),
      );
      const contacts = await within(page).findByRole("region", { name: "Contacts" }, LONG);
      await within(contacts).findByRole("cell", { name: "Lucius Fox" }, LONG);
      await user.click(within(contacts).getByRole("button", { name: "Edit contacts row 1" }));
      const edit = await within(contacts).findByRole("form", { name: "Edit Contact" }, LONG);
      const title = await within(edit).findByRole("textbox", { name: "Job title" }, LONG);
      await user.type(title, "CEO");
      await user.click(within(edit).getByRole("button", { name: "Save" }));
      expect(await within(contacts).findByRole("cell", { name: "CEO" }, LONG)).toBeVisible();
      await user.click(within(contacts).getByRole("button", { name: "Delete contacts row 1" }));
      await user.click(await screen.findByRole("button", { name: "Confirm" }));
      expect(await within(contacts).findByText("No contacts yet.", {}, LONG)).toBeVisible();
      journey.check(
        "contact deleted, deal kept with no contact (ON DELETE SET NULL)",
        await sql(
          "SELECT (SELECT count(*) FROM contacts WHERE company_id = 6), contact_id FROM deals WHERE company_id = 6",
        ),
        [[0, null]],
      );
    });

    await journey.step("Sales rep role: no delete on companies", async () => {
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Preview as role" }),
        "Sales rep",
      );
      await showList(user, "Companies");
      await user.click(await within(page).findByRole("row", { name: "Open Acme Corp" }, LONG));
      const company = await within(page).findByRole("form", { name: "Company" }, LONG);
      expect(await within(company).findByRole("button", { name: "Edit" }, LONG)).toBeVisible();
      journey.check(
        "delete hidden",
        within(company).queryByRole("button", { name: "Delete" }),
        null,
      );
      expect(screen.queryByRole("button", { name: "Deal stages" })).toBeNull();
      await user.selectOptions(screen.getByRole("combobox", { name: "Preview as role" }), "");
    });

    await journey.step("Delete a company: foreign keys cascade", async () => {
      await showList(user, "Companies");
      await user.click(
        await within(page).findByRole("row", { name: "Open Wayne Enterprises" }, LONG),
      );
      const company = await within(page).findByRole("form", { name: "Company" }, LONG);
      const remove = await within(company).findByRole("button", { name: "Delete" }, LONG);
      await waitFor(() => expect(remove).toBeEnabled(), LONG);
      await user.click(remove);
      await user.click(await screen.findByRole("button", { name: "Confirm" }, LONG));
      await eventually(async () => expect(await scalar("SELECT count(*) FROM companies")).toBe(5));
      journey.check(
        "deals and activities of the company are gone",
        await sql("SELECT (SELECT count(*) FROM deals), (SELECT count(*) FROM activities)"),
        [[10, 12]],
      );
    });
  });
}, 180_000);

it("CRM: archive save, close, and reopen keeps definitions and records identical", async () => {
  await withJourney(APP, "archive-round-trip", async (journey) => {
    const user = await journey.step("Create CRM from the start screen", () =>
      startFromTemplate("CRM"),
    );
    const before = await invoke("read_document_config", { windowLabel: "main" });
    const snapshot = () =>
      Promise.all(
        ["deal_stages", "companies", "contacts", "deals", "activities"].map((table) =>
          sql(`SELECT * FROM ${table} ORDER BY id`),
        ),
      );
    const records = await snapshot();
    const archive = join(process.env.IXTABLE_STATE_DIR!, "crm-golden.ixt");
    await journey.step("Save as .ixt", async () => {
      dialogMock.save.mockResolvedValueOnce(archive);
      await user.click(screen.getByRole("button", { name: "Save project" }));
      await screen.findByText("Saved archive", {}, LONG);
    });
    await journey.step("Close and reopen", async () => {
      await user.click(screen.getByRole("button", { name: "Close project" }));
      dialogMock.open.mockResolvedValueOnce(archive);
      await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
      await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
    });
    await journey.step("Compare definitions and records", async () => {
      journey.check(
        "definitions identical",
        await invoke("read_document_config", { windowLabel: "main" }),
        before,
      );
      journey.check("records identical", await snapshot(), records);
      journey.check("still valid", errorsOf(await validateDocument()), []);
    });
  });
}, 120_000);
