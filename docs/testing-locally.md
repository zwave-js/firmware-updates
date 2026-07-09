# Testing the service locally

## Getting started

The firmware update service can be tested locally. To get started, install everything:

```bash
yarn
```

To start the service, run

```bash
yarn dev
```

This compiles the firmware definition files into the data served by the worker (`yarn build:data`) and starts a local server. Unlike production, it does not rebuild automatically when the firmware files change — rerun `yarn dev` (or `yarn build:data`) after editing them.

## Using the local service

Z-Wave JS can be configured to use the local service by setting the `ZWAVEJS_FW_SERVICE_URL` environment variable to `http://localhost:8787`.
