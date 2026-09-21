# JOY Media Windows Docker self-hosted runner

Required labels: `self-hosted,windows,x64,joy-media-worker-docker`

This is the only accepted Windows CI lane for JOY Media private repositories.
It runs inside a Windows Docker Desktop container on the owner-controlled PC.
Host-direct Windows runners, GitHub-hosted runners, and Linux containers are
not substitutes for this lane.

The release workflow must pass the exact candidate SHA and write the complete
Windows acceptance record before `release:gate` can pass. See
[contract.md](contract.md) for the build, registration, token, container
identity, and container-local acceptance contract.
