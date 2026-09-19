import { Suspense } from 'react';
import { observer } from 'mobx-react-lite';
import CkkLoader from '@/components/loader/ckk-loader';
import { useDevice } from '@deriv-com/ui';
import ChartModalDesktop from './chart-modal-desktop';

export const ChartModal = observer(() => {
    const { isDesktop } = useDevice();
    return <Suspense fallback={<CkkLoader />}>{isDesktop && <ChartModalDesktop />}</Suspense>;
});

export default ChartModal;
