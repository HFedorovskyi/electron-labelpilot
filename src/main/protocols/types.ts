
export interface ScaleReading {
    weight: number;
    unit: 'kg' | 'g' | 'lb';
    stable: boolean;
    tare?: number;
}

export interface ScaleProtocol {
    id: string;
    name: string;
    description: string;

    // Command strategies
    pollingRequired: boolean;
    defaultBaudRate?: number;

    // Core methods
    parse(data: Buffer | string): ScaleReading | null;
    getWeightCommand?(): Buffer | string;
    getZeroCommand?(): Buffer | string;
    getTareCommand?(): Buffer | string;
}
