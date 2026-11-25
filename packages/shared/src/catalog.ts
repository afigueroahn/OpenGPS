// Device catalog.

export interface SetupStep {
  title: string;
  /** Text with {host}, {ip} and {port}, which the web app replaces with the server's. */
  text: string;
  /** Example command, also with {host}, {ip} and {port}. */
  command?: string;
}

export interface DeviceModel {
  id: string;
  brand: string;
  name: string;
  examples: string;
  protocol: string;
  port: number;
  /** What the identifier is called on that device: "IMEI" or "ID". */
  idLabel: string;
  setup: SetupStep[];
  /** Models known to belong to this family, to find a device by its name. */
  models: string[];
}
