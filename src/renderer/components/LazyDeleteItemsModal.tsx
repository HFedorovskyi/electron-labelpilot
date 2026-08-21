import { lazy, Suspense } from 'react';
import type { DeleteItemsModalProps } from './DeleteItemsModal';

const DeleteItemsModal = lazy(() => import('./DeleteItemsModal'));

const LazyDeleteItemsModal = (props: DeleteItemsModalProps) => {
    if (!props.isOpen) return null;
    return (
        <Suspense fallback={null}>
            <DeleteItemsModal {...props} />
        </Suspense>
    );
};

export default LazyDeleteItemsModal;
