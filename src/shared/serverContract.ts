export type SyncRecord = Record<string, unknown>;

export interface StationSyncIdentity {
    uuid: string;
    number: number | string;
    name: string;
    server_url: string;
}

export interface SyncPayload extends SyncRecord {
    operators?: SyncRecord[];
    barcodes?: SyncRecord[];
    barcode_templates?: SyncRecord[];
    labels?: SyncRecord[];
    label_templates?: SyncRecord[];
    containers?: SyncRecord[];
    container?: SyncRecord[];
    nomenclature?: SyncRecord[];
    nomenclatures?: SyncRecord[];
    global_attributes?: SyncRecord[];
    product_pack_links?: SyncRecord[];
    packs?: SyncRecord[];
    station_number?: number | string;
}

export interface SyncMetadata extends SyncRecord {
    type: string;
    generated_at: string;
    format_version?: string;
    server_version?: string;
    min_client_version?: string;
}

export interface UnifiedSyncEnvelope {
    station: StationSyncIdentity;
    payload: SyncPayload;
    meta: SyncMetadata;
}

export interface ServerPingResponse {
    status: string;
    server_version?: string;
    min_client_version?: string;
}

const ARRAY_FIELDS = [
    'operators',
    'barcodes',
    'barcode_templates',
    'labels',
    'label_templates',
    'containers',
    'container',
    'nomenclature',
    'nomenclatures',
    'global_attributes',
    'product_pack_links',
    'packs',
] as const;

function isRecord(value: unknown): value is SyncRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(parent: SyncRecord, key: string): SyncRecord {
    const value = parent[key];
    if (!isRecord(value)) {
        throw new Error(`Invalid unified data format: '${key}' must be an object.`);
    }
    return value;
}

function requireString(parent: SyncRecord, key: string): string {
    const value = parent[key];
    if (typeof value !== 'string') {
        throw new Error(`Invalid unified data format: '${key}' must be a string.`);
    }
    return value;
}

export function parseUnifiedSyncEnvelope(value: unknown): UnifiedSyncEnvelope {
    if (!isRecord(value)) {
        throw new Error('Invalid unified data format: root must be an object.');
    }

    const station = requireRecord(value, 'station');
    const payload = requireRecord(value, 'payload');
    const meta = requireRecord(value, 'meta');

    requireString(station, 'uuid');
    const stationNumber = station.number;
    if ((typeof stationNumber !== 'number' || !Number.isInteger(stationNumber)) &&
        (typeof stationNumber !== 'string' || !/^\d+$/.test(stationNumber.trim()))) {
        throw new Error("Invalid unified data format: 'station.number' must be an integer or numeric string.");
    }
    requireString(station, 'name');
    requireString(station, 'server_url');
    requireString(meta, 'type');
    requireString(meta, 'generated_at');

    for (const field of ARRAY_FIELDS) {
        const rows = payload[field];
        if (rows !== undefined && !Array.isArray(rows)) {
            throw new Error(`Invalid unified data format: 'payload.${field}' must be an array when present.`);
        }
    }

    for (const optionalString of ['format_version', 'server_version', 'min_client_version'] as const) {
        const field = meta[optionalString];
        if (field !== undefined && typeof field !== 'string') {
            throw new Error(`Invalid unified data format: 'meta.${optionalString}' must be a string when present.`);
        }
    }

    return value as unknown as UnifiedSyncEnvelope;
}

export function parseServerPingResponse(value: unknown): ServerPingResponse {
    if (!isRecord(value)) {
        throw new Error('Invalid server ping response: root must be an object.');
    }
    const status = requireString(value, 'status');
    const serverVersion = value.server_version;
    const minClientVersion = value.min_client_version;
    if (serverVersion !== undefined && typeof serverVersion !== 'string') {
        throw new Error("Invalid server ping response: 'server_version' must be a string.");
    }
    if (minClientVersion !== undefined && typeof minClientVersion !== 'string') {
        throw new Error("Invalid server ping response: 'min_client_version' must be a string.");
    }
    return {
        status,
        ...(serverVersion === undefined ? {} : { server_version: serverVersion }),
        ...(minClientVersion === undefined ? {} : { min_client_version: minClientVersion }),
    };
}
