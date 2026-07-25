# Local Diagnostics Use The Terminal And Bounded Files

Throughline emits the same metadata-only operational events to two local surfaces: human-readable Effect logs on the launching terminal and structured NDJSON logs under the application data directory. The desktop shell, server, and supervised child output keep distinct files, stable run and job identifiers, and bounded active-plus-previous retention. Development mirrors the server child's stdout and stderr into the desktop command's terminal as well as retaining them, while packaged launches rely on the files and expose their directory from Settings.

An unavailable log directory must never become an application dependency: the
affected file sink reports the problem once, then disables itself while
terminal diagnostics and the product continue to run.

Operational logs may contain lifecycle stages, component names, pull-request identity, process and job identifiers, typed error codes, and sanitized causes. They must not contain bootstrap or bearer credentials, GitHub tokens, WebSocket query strings, prompts, diffs, harness output, or transcript contents. Harness transcripts remain separate, sensitive run artifacts and are never included in general diagnostics automatically. This keeps local diagnosis useful without creating telemetry or a second copy of the reviewer's source material.

Renderer console payloads are deliberately not mirrored into desktop diagnostics. A browser or dependency can include rendered source, diff text, or prompt material in an otherwise ordinary console error, and redacting credential-shaped substrings cannot make that arbitrary payload metadata-only. Main-process diagnostics instead record structural renderer failures such as load error codes, process-exit reasons, preload failures, and unresponsive-window events.
