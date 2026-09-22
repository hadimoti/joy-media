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

If Windows-container NAT cannot reach the public download hosts, the same
build can use an owner-controlled temporary HTTP artifact mirror by adding
`--build-arg ARTIFACT_BASE_URL=http://host.docker.internal:<port>` and
`--build-arg COREPACK_NPM_REGISTRY=http://host.docker.internal:<port>/npm`.
The repository includes `artifact-mirror.py` for this temporary host-local
service. The image still verifies every downloaded file against the pinned
SHA-256 values; the mirror changes transport only, not artifact identity, and
its URL is not retained in the final image environment. Leave both arguments
unset for the normal direct-download path.
