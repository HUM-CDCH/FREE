import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeCsv } from "./csv.js";
import { toTable } from "./table.js";

test("quotes delimiters, quotation marks, and line breaks", () => {
  assert.equal(
    serializeCsv(toTable({ a: "comma,value", b: 'say "hi"', c: "two\nlines" })),
    'a,b,c\r\n"comma,value","say ""hi""","two\nlines"',
  );
});

test("protects each formula prefix and keeps primitives native", () => {
  assert.equal(
    serializeCsv(
      toTable({
        equals: "=1+1",
        plus: "+1",
        minus: "-1",
        at: "@SUM(A1)",
        safe: "  =1",
        number: -1,
        flag: false,
        nothing: null,
      }),
    ),
    "equals,plus,minus,at,safe,number,flag,nothing\r\n'=1+1,'+1,'-1,'@SUM(A1),  =1,-1,false,",
  );
});

test("writes an empty cell where a record has no value for a column", () => {
  assert.equal(
    serializeCsv(toTable([{ a: 1 }, { b: 2 }])),
    "a,b\r\n1,\r\n,2",
  );
});
