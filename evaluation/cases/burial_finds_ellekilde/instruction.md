# Extraction instructions

Extract one `entries` object for every grave section headed
`Grav <number>`.

`Grav_id` is only the number from that heading. `Ark_no` is the number or
number list immediately following the heading, copied verbatim.

`fundliste` contains only rows from an explicit table introduced by
`Fundliste grav <number>` or `Fundliste til grav <number>`. A fund table may
continue after a page separator (`---`) and a repeated table header. Merge
both parts into the same grave's `fundliste` without losing or duplicating
rows.

Do not treat tables introduced by `Skeletdelene er nummereret` as fund lists.
Do not turn numbered skeletal parts or grave equipment mentioned only in
prose into `fundliste` items. If a grave has no explicit fund-list table,
return an empty `fundliste` array.

For each fund-list row:

- copy `Fund_no` and `Fund_beskrivelse` verbatim;
- copy the complete table `Bemærkninger` cell verbatim into
  `Fund_bemaerkning`; never remove location words from this value;
- put an explicitly stated physical location into `Fundplacering`; it may
  duplicate part or all of `Fund_bemaerkning`, and it may come from the
  surrounding grave-equipment prose for that same `Fund_no`;
- use an empty string for a field that the source does not provide.
