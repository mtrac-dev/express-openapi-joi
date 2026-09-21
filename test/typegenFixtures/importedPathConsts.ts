// Declared with `as const`, the way a shared param-name constant
// typically is in a real app (e.g. a shared src/routers/paths.ts) --
// its initializer is an AsExpression wrapping the string literal, not a
// bare StringLiteral node.
export const GADGET_ID = 'gadget_id' as const;
