# Testing the service locally

## Getting started

The firmware update service can be tested locally. To get started, install and build everything:

```bash
yarn
yarn build
```

and create a file `.env` with the following content

```ini
API_REQUIRE_KEY=false
ADMIN_SECRET=your-random-admin-secret
```

To start the service, run

```bash
yarn dev
```

This will also rebuild on changes.

## Uploading firmware files

The database behind the local service is initially empty and decoupled from the repository contents. Firmware definition files need to be uploaded manually.

To do so, build the index, which also checks the files for errors:

```bash
yarn build:index
```

Then upload the files to the running service:

```bash
ADMIN_SECRET=your-random-admin-secret BASE_URL=http://localhost:8787 yarn upload
```

These steps need to be repeated whenever the firmware files change.

## Using the local service

Z-Wave JS can be configured to use the local service by setting the `ZWAVEJS_FW_SERVICE_URL` environment variable to `http://localhost:8787`.
