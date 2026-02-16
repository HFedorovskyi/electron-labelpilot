
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
    // Optional hardware overrides
    defaultBaudRate?: number;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    dataBits?: 5 | 6 | 7 | 8;
    stopBits?: 1 | 2;

    // Core methods
    parse(data: Buffer | string): ScaleReading | null;
    getWeightCommand?(): Buffer | string;
    getZeroCommand?(): Buffer | string;
    getTareCommand?(): Buffer | string;
}
