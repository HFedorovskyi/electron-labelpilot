import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const NumericKeypad = lazy(() => import('./NumericKeypad'));
type NumericKeypadProps = ComponentProps<typeof NumericKeypad>;

const LazyNumericKeypad = (props: NumericKeypadProps) => (
    <Suspense fallback={null}>
        <NumericKeypad {...props} />
    </Suspense>
);

export default LazyNumericKeypad;
