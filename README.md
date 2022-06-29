# Z-Wave JS Firmware Update Service

This is the web service powering semi-automatic firmware updates in Z-Wave JS.

## How it works

Firmware upgrades are defined in the files in the `firmware` directory. This information is parsed by the web service and used to respond to requests.

Z-Wave JS will query the web service on demand, providing the device identification of the device to be updated. If an update is available, the web service will respond with the necessary information to display to the user.

When desired, Z-Wave JS will download the update(s) from the provided URL, verify their integrity and install them.

## Providing firmware definition files

We kindly ask you to open a PR for any changes to firmware updates.
This way they can automatically be checked for errors.

See [the documentation](docs/firmware-files.md) for more information on how to author these files.

## How to use?

Send a HTTP request to one of the API endpoints. Currently these are defined:

### API v1, get updates

```
POST https://firmware.zwave-js.io/api/v1/updates
Content-Type: application/json

{
    "manufacturerId": "0x1234",
    "productType": "0xabcd",
    "productId": "0xcafe",
    "firmwareVersion": "1.6"
}
```

Example response:

```json
[
    {
        "version": "1.7",
        "changelog": "* Fixed some bugs\n*Added more bugs",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
                "url": "https://example.com/firmware/1.7.otz"
            }
        ]
    }
]
```

Response type definition:

```ts
type APIv1_Response = {
    version: string;
    changelog: string;
    files: {
        target: number;
        url: string;
        integrity: string;
    }[];
}[];
```
