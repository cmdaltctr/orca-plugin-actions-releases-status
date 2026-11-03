// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// The worker would call the real `gh`, so each scenario leaves the lookups to fail fast and
// the panel shows its error state; the logic itself is covered by the unit tests.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {}
})
