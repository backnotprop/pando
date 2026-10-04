// Pando's syntax colour theme for @pierre/diffs (Shiki): its tokens take the
// --diffs-token-* variables in theme.css, so one highlighted result fits every
// theme. Registered here, once, for the code view (-code/Colour.tsx) and for
// code fences in documents (doc/PlannotatorDoc.tsx): Pierre logs an error when
// a name is registered twice. Both load this module on first use.
import { registerCustomCSSVariableTheme } from "@pierre/diffs";

export const SYNTAX_THEME = "pando";

registerCustomCSSVariableTheme(SYNTAX_THEME, {});
