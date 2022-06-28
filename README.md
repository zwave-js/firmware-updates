# Z-Wave JS Firmware Update Service

This is the web service powering semi-automatic firmware updates in Z-Wave JS.

## How it works

Firmware upgrades are defined in the files in the `firmware` directory. This information is parsed by the web service and used to respond to requests.

Z-Wave JS will query the web service on demand, providing the device identification of the device to be updated. If an update is available, the web service will respond with the necessary information to display to the user.

When desired, Z-Wave JS will download the update(s) from the provided URL, verify their integrity and install them.

## Defining firmware updates

WIP, see https://github.com/zwave-js/node-zwave-js/issues/4739
