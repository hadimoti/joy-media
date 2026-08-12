# WP-32 evidence — real-project workflow acceptance

This redacted evidence package records the WP-32 acceptance run for the final
implementation source commit
`6d3b4677e0616bd6e0219ee9b871f941cb2c6ac1`.
It contains no session tokens, media bytes, private URLs, project titles from
the live account, or absolute workstation paths.

The gate covered a disposable project created through the visible Projects
flow, real fixture import, previews, timeline placement/editing, captions,
browser audio processing, MP4 export, Process Center reload/re-download, and
exact cleanup. The journey and responsive checks passed in all three desktop
viewport projects. The final candidate passed GitHub workflow `31622521087`;
its immutable API and editor releases are live.

The signed-in production run reopened the disposable project, verified the
authored workflow surfaces, and purged that exact project through Projects →
Trash → typed permanent deletion. Projects returned from 3 to 2 and Trash from
0 to 1 to 0; both protected pre-existing projects remained present. The
in-app browser's range-input helper can alter the visible DOM value without
dispatching React's controlled `onChange`; the final mixer persistence claim is
therefore backed by the focused component regression, the full GitHub browser
audit, and the deployed bundle parity check rather than that helper's synthetic
event path.

During browser-surface recovery, a separate Chrome-profile-only disposable
project was created while testing the upload path. It was also moved to Trash
and permanently purged by exact title; Chrome's pre-existing Trash item and its
two protected projects were preserved.

The broader WP-29 audit was also sampled. Its high-parallelism run reported
known Worker/fixture-contending failures outside WP-32; those cases are listed
as out-of-scope observations in the friction ledger. They did not fail the
WP-32 journey, responsive matrix, primary asset regression, unit suite, or
build gate.
