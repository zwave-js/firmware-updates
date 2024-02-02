# Z-Wave JS Firmware Update Service

This is the web service powering semi-automatic firmware updates in Z-Wave JS.

## How it works

Firmware upgrades are defined in the files in the `firmware` directory. This information is parsed by the web service and used to respond to requests.

Z-Wave JS will query the web service on demand, providing the device identification of the device to be updated. If an update is available, the web service will respond with the necessary information to display to the user.

When desired, Z-Wave JS will download the update(s) from the provided URL, verify their integrity and install them.

## Providing firmware definition files

> [!WARNING]
> We **will not** accept firmware updates hosted by third parties. All updates must come from the respective device manufacturer. We make an exception for firmwares that are publicly hosted by the manufacturer, but those may still require confirmation the manufacturer's confirmation before merging.

We kindly ask you to open a PR for any changes to firmware updates.
This way they can automatically be checked for errors.

See [the documentation](docs/firmware-files.md) for more information on how to author these files.

## How to use?

### API Keys

All requests to the API require an API key, provided using the `X-API-Key` HTTP header. API keys are **free for non-commercial use** or installations in non-commercial environments. Commercial use will be charged.

> [!NOTE]
> Home Assistant and official Z-Wave JS projects already have an API key for non-commercial use. Requesting an API key is not necessary for those.

To request an API key, please [reach out](mailto:info@zwave-js.io) and provide the following information:

-   Project/Company name
-   Open source / Commercial
-   Repository URL (open source only)
-   Approximate no. of requests/hour

Once you have your API key, you can use it to make HTTP requests to the API endpoints. Currently these are defined:

### API v1, get updates

```
POST https://firmware.zwave-js.io/api/v1/updates
Content-Type: application/json
X-API-Key: <Your API Key>

{
    "manufacturerId": "0x1234",
    "productType": "0xabcd",
    "productId": "0xcafe",
    "firmwareVersion": "1.6"
}
```

The `firmwareVersion` field may also contain a patch version, e.g. `1.6.1`. When no patch version is provided, it will be assumed to be `0`, so `1.6` is equivalent to `1.6.0`.

**Example response:**

```json
[
    {
        "version": "1.5",
        "changelog": "* Initial release",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:45d004e1b5997a053f1de40753d19fc534fd657080810cfb697b868a3cf0e764",
                "url": "https://example.com/firmware/1.5.otz"
            }
        ],
        "downgrade": true,
        "normalizedVersion": "1.5.0"
    },
    {
        "version": "1.7",
        "changelog": "* Fixed some bugs\n*Added more bugs",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
                "url": "https://example.com/firmware/1.7.otz"
            }
        ],
        "downgrade": false,
        "normalizedVersion": "1.7.0"
    }
]
```

To help applications decide which updates to show and how, additional fields are added to the response:

-   `downgrade`: Whether this version is a downgrade (`true`) or an upgrade (`false`). Applications may want to only show downgrades when specifically requested.
-   `normalizedVersion`: A normalized, [semver](https://semver.org/) compatible representation of the version field to make it easier to compare them. Examples:
    -   version `1.7` becomes `1.7.0`
    -   version `1.7.0` stays `1.7.0`
    -   version `1.7.2` stays `1.7.2`

> [!NOTE]
> API version 1 will only return updates from the `stable` channel. To also get updates from the `beta` channel, use API version 2.

**Response type definition:**

```ts
type APIv1_Response = {
    version: string;
    changelog: string;
    files: {
        target: number;
        url: string;
        integrity: string;
    }[];
    downgrade: boolean;
    normalizedVersion: string;
}[];
```

### API v2, get updates

```
POST https://firmware.zwave-js.io/api/v2/updates
Content-Type: application/json
X-API-Key: <Your API Key>

{
    "manufacturerId": "0x1234",
    "productType": "0xabcd",
    "productId": "0xcafe",
    "firmwareVersion": "1.6"
}
```

Changes compared to v1:

-   Adds the `channel` field to the response, which can be either `stable` or `beta`
-   `normalizedVersion` distinguishes between versions from the `stable` and `beta` channels. Examples:
    -   stable version `1.7` becomes `1.7.0`
    -   stable version `1.7.0` stays `1.7.0`
    -   stable version `1.7.2` stays `1.7.2`
    -   beta version `1.8` becomes `1.8.0-beta`
    -   beta version `1.8.2` becomes `1.8.2-beta`

**Example response:**

```json
[
    {
        "version": "1.7",
        "changelog": "* Fixed some bugs\n*Added more bugs",
        "channel": "stable",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
                "url": "https://example.com/firmware/1.7.otz"
            }
        ],
        "downgrade": false,
        "normalizedVersion": "1.7.0"
    },
    {
        "version": "1.8",
        "changelog": "* Fixed some bugs\n*Added more bugs",
        "channel": "beta",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:833f9eea2328cb05cbddc00b482e73225a09ca15dc8f90060e8b58ed9aa83a99",
                "url": "https://example.com/firmware/1.8.otz"
            }
        ],
        "downgrade": false,
        "normalizedVersion": "1.8.0-beta"
    }
]
```

**Response type definition:**

```ts
type APIv2_Response = {
    version: string;
    changelog: string;
    channel: "stable" | "beta";
    files: {
        target: number;
        url: string;
        integrity: string;
    }[];
    downgrade: boolean;
    normalizedVersion: string;
}[];
```

### API v3, get updates

```
POST https://firmware.zwave-js.io/api/v3/updates
Content-Type: application/json
X-API-Key: <Your API Key>

{
    "manufacturerId": "0x1234",
    "productType": "0xabcd",
    "productId": "0xcafe",
    "firmwareVersion": "1.6",
    "region": "europe"
}
```

Changes compared to v2:

-   Adds the **optional** `region` field to both the request and the response, which can be one of these values:
    -   `"europe"`
    -   `"usa"`
    -   `"australia/new zealand"`
    -   `"hong kong"`
    -   `"india"`
    -   `"israel"`
    -   `"russia"`
    -   `"china"`
    -   `"japan"`
    -   `"korea"`

If the `region` field is present in the request, the response will only contain updates for that region, or updates without a specified region (which are assumed to be region-agnostic).
If no `region` is specified in the request, the response will only contain updates without a specified region.

Previous API versions will ignore the `region` field in the request and will not return updates with a specified region.

**Example response:**

```json
[
    {
        "version": "1.7",
        "changelog": "EU Version:\n* Fixed some bugs\n*Added more bugs",
        "channel": "stable",
        "files": [
            {
                "target": 0,
                "integrity": "sha256:cd19da525f20096a817197bf263f3fdbe6485f00ec7354b691171358ebb9f1a1",
                "url": "https://example.com/firmware/1.7-eu.otz"
            }
        ],
        "downgrade": false,
        "normalizedVersion": "1.7.0",
        "region": "europe"
    }
]
```

**Response type definition:**

```ts
type APIv3_Response = {
    version: string;
    changelog: string;
    channel: "stable" | "beta";
    region?:
        | "europe"
        | "usa"
        | "australia/new zealand"
        | "hong kong"
        | "india"
        | "israel"
        | "russia"
        | "china"
        | "japan"
        | "korea";
    files: {
        target: number;
        url: string;
        integrity: string;
    }[];
    downgrade: boolean;
    normalizedVersion: string;
}[];
```

## Development and testing locally

See [the documentation](docs/testing-locally.md) for more information on how to test the service locally.
