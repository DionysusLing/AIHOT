import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { selectBenchRun } from "@aihot/backend/admin/selectbench";
import { buildApp } from "../apps/api/src/app.ts";

config.devAdmin = { displayName: "SelectBench consistency test" };
config.environmentName = "development";
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

const item = { caseId: "shared-case", title: "A report", gold: "select", decision: "select" };
const model = (cases: unknown[]) => ({ summary: { n: cases.length }, cases });
const counts = async () => (await sql`SELECT (SELECT count(*)::int FROM selectbench_runs) AS runs,
  (SELECT count(*)::int FROM selectbench_results) AS cases, (SELECT count(*)::int FROM audit_log) AS audits`)[0]!;
const upload = (report: unknown) => app.inject({ method: "POST", url: "/api/admin/selectbench/import",
  headers: { "x-csrf-token": "dev" }, payload: { label: "Consistency regression", report } });

async function rejected(report: unknown, status = 400) {
  const before = await counts();
  const response = await upload(report);
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(await counts(), before, "failed import must not leave runs, results, or audit records");
}

test("conflicting gold across models returns 400 without writes in both report formats", async (t) => {
  for (const gold of ["select", "reject", "either"]) {
    for (const otherGold of ["select", "reject", "either"].filter((value) => value !== gold)) {
      for (const legacy of [false, true]) {
        await t.test(`${gold}/${otherGold}, legacy=${legacy}`, async () => {
          const models = { first: model([{ ...item, gold }]), second: model([{ ...item, gold: otherGold }]) };
          await rejected(legacy ? models : { models });
        });
      }
    }
  }
});

test("duplicate caseId within one model is rejected even when gold agrees", async (t) => {
  for (const gold of ["select", "reject"]) {
    await t.test(gold, () => rejected({ models: {
      first: model([item]), second: model([item, { ...item, gold }]),
    } }));
  }
});

test("invalid gold and malformed evidence are rejected before writing an earlier valid model", async (t) => {
  for (const gold of ["unknown", "SELECT", "", null, 1, true, {}, ["select"], undefined]) {
    await t.test(`gold=${JSON.stringify(gold)}`, () => rejected({ models: {
      first: model([item]), second: model([{ ...item, gold }]),
    } }));
  }
  for (const cases of [null, {}, "cases", [null], [{ ...item, caseId: "" }], [{ ...item, caseId: 1 }]]) {
    await t.test(`cases=${JSON.stringify(cases)}`, () => rejected({ models: {
      first: model([item]), second: { summary: { n: 1 }, cases },
    } }));
  }
});

test("a conflict after the 500-row batch boundary leaves no partial import", async () => {
  const cases = Array.from({ length: 501 }, (_, i) => ({ ...item, caseId: `batch-${i}` }));
  await rejected({ models: { first: model(cases), second: model([
    { ...item, caseId: "second-only" }, { ...cases[500], gold: "reject" },
  ]) } });
});

test("database failure after an earlier model insert rolls back the entire run", async () => {
  await rejected({ models: { first: model([item]), second: model([{ ...item, title: null }]) } }, 500);
});

test("shared gold permits different predictions, partial coverage, and summary-only models", async () => {
  const before = await counts();
  const response = await upload({ models: {
    first: model([item, { ...item, caseId: "first-only", gold: "reject", decision: "reject" }]),
    second: model([{ ...item, decision: "reject" }, { ...item, caseId: "second-only", gold: "either", decision: null }]),
    summaryOnly: { summary: { n: 2 } },
  } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await counts(), { runs: before.runs + 1, cases: before.cases + 4, audits: before.audits + 1 });
  const id = response.json().id;
  const detail = await selectBenchRun(id, {});
  assert.ok(detail);
  assert.equal(detail.rows.length, 3);
  const shared = detail.rows.find((row) => row.case_id === item.caseId)!;
  assert.equal(shared.gold, "select");
  assert.equal(shared.by_model.first.decision, "select");
  assert.equal(shared.by_model.second.decision, "reject");
  assert.deepEqual(Object.keys(detail.rows.find((row) => row.case_id === "first-only")!.by_model), ["first"]);
  assert.deepEqual(Object.keys(detail.rows.find((row) => row.case_id === "second-only")!.by_model), ["second"]);
  for (const filter of [{ disagree: true }, { model: "second", outcome: "fn" }, { model: "first", outcome: "tp" }]) {
    assert.deepEqual((await selectBenchRun(id, filter))!.rows.map((row) => row.case_id), [item.caseId]);
  }
  assert.equal((await selectBenchRun(id, { model: "second", outcome: "either" }))!.rows[0]!.case_id, "second-only");
});

test("matching gold is accepted across models for every valid gold in legacy reports", async () => {
  const cases = ["select", "reject", "either"].map((gold) => ({ ...item, caseId: gold, gold }));
  const response = await upload({ meta: { split: "holdout" }, first: model(cases), second: model(cases) });
  assert.equal(response.statusCode, 200, response.body);
  const detail = await selectBenchRun(response.json().id, {});
  assert.equal(detail!.run.split, "holdout");
  assert.equal(detail!.rows.length, 3);
  for (const row of detail!.rows) {
    assert.equal(row.gold, row.case_id);
    assert.deepEqual(Object.keys(row.by_model).sort(), ["first", "second"]);
  }
});

test("summary-only reports, including empty cases arrays, retain both report formats", async (t) => {
  for (const legacy of [false, true]) {
    await t.test(`legacy=${legacy}`, async () => {
      const before = await counts();
      const models = { first: { summary: { n: 2 } }, second: { summary: { n: 2 }, cases: [] } };
      const response = await upload(legacy ? models : { models });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(await counts(), { runs: before.runs + 1, cases: before.cases, audits: before.audits + 1 });
      const detail = await selectBenchRun(response.json().id, {});
      assert.equal(detail!.run.sample_size, 2);
      assert.deepEqual(detail!.run.models, ["first", "second"]);
      assert.equal(detail!.rows.length, 0);
    });
  }
});
