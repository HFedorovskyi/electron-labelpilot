import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export interface CurrentOperator {
    uuid: string;
    full_name: string;
    short_code?: string;
}

interface SessionState {
    operator: CurrentOperator | null;
    /** A synthetic demo operator forces a logged-in state without a real DB operator. */
    isDemo: boolean;
    refresh: () => Promise<void>;
    logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
    operator: null,
    isDemo: false,
    refresh: async () => {},
    logout: async () => {},
});

interface SessionProviderProps {
    children: React.ReactNode;
    /** When set, the app is in demo mode: bypass login with this synthetic operator. */
    demoOperator?: CurrentOperator | null;
}

export function SessionProvider({ children, demoOperator = null }: SessionProviderProps) {
    const [operator, setOperator] = useState<CurrentOperator | null>(demoOperator);

    const refresh = useCallback(async () => {
        if (demoOperator) {
            setOperator(demoOperator);
            return;
        }
        try {
            const op = await window.electron.invoke('session:get');
            setOperator(op ?? null);
        } catch {
            setOperator(null);
        }
    }, [demoOperator]);

    const logout = useCallback(async () => {
        if (demoOperator) return; // demo session is not logged out
        try {
            await window.electron.invoke('session:logout');
        } catch {
            /* ignore */
        }
        setOperator(null);
    }, [demoOperator]);

    useEffect(() => {
        // Demo mode: lock to the synthetic operator and skip IPC entirely.
        if (demoOperator) {
            setOperator(demoOperator);
            return;
        }
        refresh();
        const remove = window.electron.on('session-changed', (op: CurrentOperator | null) => {
            setOperator(op ?? null);
        });
        return () => remove();
    }, [demoOperator, refresh]);

    const value: SessionState = {
        operator,
        isDemo: !!demoOperator,
        refresh,
        logout,
    };

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
