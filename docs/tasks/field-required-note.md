# One test to move (owned by the typecheck pass right now)

`tests/pdf/edge-security.test.ts:282-284` calls `tool.validate()` directly and
expects it to return the missing-password sentences. The `protect` tool no longer
holds those two rules in `validate`: they moved to the fields themselves
(`required` + `missing`), so the message renders on the box it belongs to instead
of a tool-level line no control can point at.

Behaviour is unchanged — the run is still refused, with the same words, and
`validate()` still owns the genuinely cross-field rule (one password for both jobs).
Update the assertion to the layer that now answers:

```ts
const field = tool.fields!.find((f) => f.key === 'userPassword')!;
expect(field.required).toBe(true);
expect(field.missing).toMatch(/password readers must type/i);
const owner = tool.fields!.find((f) => f.key === 'ownerPassword')!;
expect(typeof owner.required).toBe('function');
expect((owner.required as (v: ToolValues) => boolean)({ mode: 'owner' })).toBe(true);
expect((owner.required as (v: ToolValues) => boolean)({ mode: 'both' })).toBe(false);
```

Leave line 286-288 (the shared-password refusal) calling `validate` — that rule is
correctly cross-field and no single box can claim it.
