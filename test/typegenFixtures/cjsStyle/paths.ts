// No `as const` here (that's already covered by ../importedPathConsts.ts) --
// just a plain string const, imported without a `.ts` extension by
// ./router.ts, the way a classic-resolution (non-NodeNext) CJS consumer's
// own router files typically would.
export const WIDGET_ID = 'widget_id';
