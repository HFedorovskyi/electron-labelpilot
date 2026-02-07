export { };

declare global {
    interface Window {
        electron: {
            send: (channel: string, data: any) => void;
            on: (channel: string, func: (...args: any[]) => void) => () => void;
            invoke: (channel: string, data?: any) => Promise<any>;
        };
    }
}
