'use strict'
// Business tool registry for resolve-lume sidecar.
//
// Merges the three batch modules (PSE pipelines / article publishing / HTTP
// services & misc) into one BUSINESS map consumed by builtin-exec.js, which
// assigns them into LOCAL so they become executable built-ins. Schemas stay
// verbatim in builtin-tools.json (mirrored from resolve-studio); this module
// only supplies the execution layer.
//
// Porting convention (see business-helpers.js for the shared runners):
//   - CommonJS, zero external npm deps;
//   - every tool is `async (args) => string`;
//   - expected user-facing failures return `error: …` strings (missing env /
//     service down / invalid input) instead of throwing;
//   - output is bounded (truncate / truncateToTail) so long pipelines never
//     blow the model context.
module.exports = {
  BUSINESS: {
    ...require('./business-pse'),
    ...require('./business-publish'),
    ...require('./business-misc'),
  },
}
