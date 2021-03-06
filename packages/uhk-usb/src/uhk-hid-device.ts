import { Device, devices, HID } from 'node-hid';
import { CommandLineArgs, DeviceConnectionState, isEqualArray, LogService } from 'uhk-common';

import {
    ConfigBufferId,
    Constants,
    EepromOperation,
    enumerationModeIdToProductId,
    EnumerationModes,
    KbootCommands,
    ModuleSlotToI2cAddress,
    ModuleSlotToId,
    UsbCommand,
    UsbVariables
} from './constants';
import { bufferToString, getTransferData, isUhkDevice, retry, snooze } from './util';

export const BOOTLOADER_TIMEOUT_MS = 5000;

/**
 * HID API wrapper to support unified logging and async write
 */
export class UhkHidDevice {
    /**
     * Internal variable that represent the USB UHK device
     * @private
     */
    private _prevDevices = [];
    private _device: HID;
    private _hasPermission = false;

    constructor(private logService: LogService,
                private options: CommandLineArgs) {
    }

    /**
     * Return true if the app has right to communicate over the USB.
     * Need only on linux.
     * If return false need to run {project-root}/rules/setup-rules.sh or
     * the Agent will ask permission to run at the first time.
     * @returns {boolean}
     */
    public hasPermission(): boolean {
        if (this.options.spe) {
            return false;
        }

        try {
            if (this._hasPermission) {
                return true;
            }

            const dev = devices().find((x: Device) => isUhkDevice(x) || x.productId === Constants.BOOTLOADER_ID);

            if (!dev) {
                return true;
            }

            const device = new HID(dev.path);
            device.close();

            this._hasPermission = true;

            return this._hasPermission;
        } catch (err) {
            this.logService.error('[UhkHidDevice] hasPermission', err);
        }

        return false;
    }

    /**
     * Return with true is an UHK Device is connected to the computer.
     * @returns {boolean}
     */
    public getDeviceConnectionState(): DeviceConnectionState {
        const devs = devices();
        const result: DeviceConnectionState = {
            bootloaderActive: false,
            connected: false,
            hasPermission: this.hasPermission()
        };

        for (const dev of devs) {
            if (isUhkDevice(dev)) {
                result.connected = true;
            } else if (dev.vendorId === Constants.VENDOR_ID &&
                dev.productId === Constants.BOOTLOADER_ID) {
                result.bootloaderActive = true;
            }
        }

        return result;
    }

    /**
     * Send data to the UHK device and wait for the response.
     * Throw an error when 1st byte of the response is not 0
     * @param {Buffer} buffer
     * @returns {Promise<Buffer>}
     */
    public async write(buffer: Buffer): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const device = this.getDevice();

            if (!device) {
                return reject(new Error('[UhkHidDevice] Device is not connected'));
            }

            device.read((err: any, receivedData: Array<number>) => {
                if (err) {
                    this.logService.error('[UhkHidDevice] Transfer error: ', err);
                    this.close();
                    return reject(err);
                }
                const logString = bufferToString(receivedData);
                this.logService.debug('[UhkHidDevice] USB[R]:', logString);

                if (receivedData[0] !== 0) {
                    return reject(new Error(`Communications error with UHK. Response code: ${receivedData[0]}`));
                }

                return resolve(Buffer.from(receivedData));
            });

            const sendData = getTransferData(buffer);
            this.logService.debug('[UhkHidDevice] USB[W]:', bufferToString(sendData).substr(3));
            device.write(sendData);
        });
    }

    public async writeConfigToEeprom(configBufferId: ConfigBufferId): Promise<void> {
        await this.write(new Buffer([UsbCommand.LaunchEepromTransfer, EepromOperation.write, configBufferId]));
        await this.waitUntilKeyboardBusy();
    }

    public async enableUsbStackTest(): Promise<void> {
        await this.write(new Buffer([UsbCommand.SetVariable, UsbVariables.testUsbStack, 1]));
        await this.waitUntilKeyboardBusy();
    }

    /**
     * Close the communication chanel with UHK Device
     */
    public close(): void {
        this.logService.debug('[UhkHidDevice] Device communication closing.');
        if (!this._device) {
            return;
        }
        this._device.close();
        this._device = null;
        this.logService.debug('[UhkHidDevice] Device communication closed.');
    }

    public async waitUntilKeyboardBusy(): Promise<void> {
        while (true) {
            const buffer = await this.write(new Buffer([UsbCommand.GetDeviceState]));
            if (buffer[1] === 0) {
                break;
            }
            this.logService.debug('Keyboard is busy, wait...');
            await snooze(200);
        }
    }

    public resetDeviceCache(): void {
        this._prevDevices = [];
    }

    async reenumerate(enumerationMode: EnumerationModes): Promise<void> {
        const reenumMode = EnumerationModes[enumerationMode].toString();
        this.logService.debug(`[UhkHidDevice] Start reenumeration, mode: ${reenumMode}`);

        const message = new Buffer([
            UsbCommand.Reenumerate,
            enumerationMode,
            BOOTLOADER_TIMEOUT_MS & 0xff,
            (BOOTLOADER_TIMEOUT_MS & 0xff << 8) >> 8,
            (BOOTLOADER_TIMEOUT_MS & 0xff << 16) >> 16,
            (BOOTLOADER_TIMEOUT_MS & 0xff << 24) >> 24
        ]);

        const enumeratedProductId = enumerationModeIdToProductId[enumerationMode.toString()];
        const startTime = new Date();
        let jumped = false;

        while (new Date().getTime() - startTime.getTime() < 20000) {
            const devs = devices();
            this.logService.silly('[UhkHidDevice] reenumeration devices', devs);

            const inBootloaderMode = devs.some((x: Device) =>
                x.vendorId === Constants.VENDOR_ID &&
                x.productId === enumeratedProductId);

            if (inBootloaderMode) {
                this.logService.debug(`[UhkHidDevice] reenumeration devices up`);
                return;
            }

            this.logService.silly(`[UhkHidDevice] Could not find reenumerated device: ${reenumMode}. Waiting...`);
            await snooze(100);

            if (!jumped) {
                const device = this.getDevice();
                if (device) {
                    const data = getTransferData(message);
                    this.logService.debug(`[UhkHidDevice] USB[T]: Enumerate device. Mode: ${reenumMode}`);
                    this.logService.debug('[UhkHidDevice] USB[W]:', bufferToString(data).substr(3));
                    device.write(data);
                    device.close();
                    jumped = true;
                } else {
                    this.logService.silly(`[UhkHidDevice] USB[T]: Enumerate device is not ready yet}`);
                }
            }
        }

        this.logService.error(`[UhkHidDevice] Could not find reenumerated device: ${reenumMode}. Timeout`);

        throw new Error(`Could not reenumerate as ${reenumMode}`);
    }

    async sendKbootCommandToModule(module: ModuleSlotToI2cAddress, command: KbootCommands, maxTry = 1): Promise<any> {
        let transfer;
        const moduleName = kbootCommandName(module);
        this.logService.debug(`[UhkHidDevice] USB[T]: Send KbootCommand ${moduleName} ${KbootCommands[command].toString()}`);
        if (command === KbootCommands.idle) {
            transfer = new Buffer([UsbCommand.SendKbootCommandToModule, command]);
        } else {
            transfer = new Buffer([UsbCommand.SendKbootCommandToModule, command, Number.parseInt(module)]);
        }
        await retry(async () => await this.write(transfer), maxTry, this.logService);
    }

    async jumpToBootloaderModule(module: ModuleSlotToId): Promise<any> {
        this.logService.debug(`[UhkHidDevice] USB[T]: Jump to bootloader. Module: ${ModuleSlotToId[module].toString()}`);
        const transfer = new Buffer([UsbCommand.JumpToModuleBootloader, module]);
        await this.write(transfer);
    }

    /**
     * Return the stored version of HID device. If not exist try to initialize.
     * @returns {HID}
     * @private
     */
    private getDevice() {
        if (!this._device) {
            this._device = this.connectToDevice();
        }

        return this._device;
    }

    /**
     * Initialize new UHK HID device.
     * @returns {HID}
     */
    private connectToDevice(): HID {
        try {
            const devs = devices();
            if (!isEqualArray(this._prevDevices, devs)) {
                this.logService.debug('[UhkHidDevice] Available devices:');
                for (const logDevice of devs) {
                    this.logService.debug(JSON.stringify(logDevice));
                }
                this._prevDevices = devs;
            } else {
                this.logService.debug('[UhkHidDevice] Available devices unchanged');
            }

            const dev = devs.find(isUhkDevice);

            if (!dev) {
                this.logService.debug('[UhkHidDevice] UHK Device not found:');
                return null;
            }
            const device = new HID(dev.path);
            this.logService.debug('[UhkHidDevice] Used device:', JSON.stringify(dev));
            return device;
        }
        catch (err) {
            this.logService.error('[UhkHidDevice] Can not create device:', err);
        }

        return null;
    }
}

function kbootCommandName(module: ModuleSlotToI2cAddress): string {
    switch (module) {
        case ModuleSlotToI2cAddress.leftHalf:
            return 'leftHalf';

        case ModuleSlotToI2cAddress.leftAddon:
            return 'leftAddon';

        case ModuleSlotToI2cAddress.rightAddon:
            return 'rightAddon';

        default:
            return 'Unknown';
    }
}
