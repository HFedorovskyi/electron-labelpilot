import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export interface CurrentOperator {
    uuid: string;
    full_name: string;
    short_code?: string;
}

export interface LogoutResult {
    ok: boolean;
    /** 'open_entities' → blocked: close the open box/pallet first. */
    reason?: string;
    openBoxCount?: number;
    openBoxNumber?: string | null;
    openPalletCount?: number;
}

interface SessionState {
    operator: CurrentOperator | null;
    /** A synthetic demo operator forces a logged-in state without a real DB operator. */
    isDemo: boolean;
    refresh: () => Promise<void>;
    logout: () => Promise<LogoutResult>;
}

const SessionContext = createContext<SessionState>({
    operator: null,
    isDemo: false,
    refresh: async () => {},
    logout: async () => ({ ok: false }),
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

    const logout = useCallback(async (): Promise<LogoutResult> => {
        if (demoOperator) return { ok: false, reason: 'demo' }; // demo session is not logged out
        try {
            const res: LogoutResult = await window.electron.invoke('session:logout');
            // Only clear on success — main refuses the logout while a box/pallet is
            // still open (the caller shows the reason to the user).
            if (res?.ok) setOperator(null);
            return res ?? { ok: true };
        } catch {
            // IPC failure: fail open like before (don't trap the user in a session).
            setOperator(null);
            return { ok: true };
        }
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
