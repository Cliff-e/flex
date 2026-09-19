import { useEffect } from 'react';
import { useStore } from '@/hooks/useStore';
import { useDevice } from '@deriv-com/ui';
import { applyTheme, readStoredTheme } from '@/utils/theme';
import './main-body.scss';

type TMainBodyProps = {
    children: React.ReactNode;
};

const MainBody: React.FC<TMainBodyProps> = ({ children }) => {
    const current_theme = localStorage.getItem('theme') ?? 'dark';
    const { ui } = useStore() ?? {
        ui: {
            setDevice: () => {},
        },
    };
    const { setDevice } = ui;
    const { isDesktop, isMobile, isTablet } = useDevice();

    useEffect(() => {
        // Keep the body in sync with the persisted theme
        // (dark | light | ckk-green) so the choice survives a reload.
        applyTheme(readStoredTheme());
    }, [current_theme]);


    useEffect(() => {
        if (isMobile) {
            setDevice('mobile');
        } else if (isTablet) {
            setDevice('tablet');
        } else {
            setDevice('desktop');
        }
    }, [isDesktop, isMobile, isTablet, setDevice]);

    return <div className='main-body'>{children}</div>;
};

export default MainBody;
