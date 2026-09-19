import classNames from 'classnames';
import './ckk-loader.scss';

type TCkkLoaderProps = {
    className?: string;
    /** Show the CKK Edge wordmark above the bars. */
    with_wordmark?: boolean;
};

/**
 * Shared CKK Edge loading indicator (brand bars, optional wordmark).
 *
 * Used by every loading surface - the boot splash path, the per-tab
 * ChunkLoader and the Blockly workspace loader - so the app never mixes
 * loading visuals (the third-party @deriv-com/ui Loader used to pop up
 * mid-page next to ours). Presentation only.
 */
const CkkLoader = ({ className, with_wordmark = false }: TCkkLoaderProps) => (
    <div className={classNames('ckk-loader', className)} data-testid='dt_ckk_loader' role='status' aria-live='polite'>
        {with_wordmark && (
            <div className='ckk-loader__wordmark'>
                <span className='ckk-loader__wordmark-ckk'>CKK</span>
                <span className='ckk-loader__wordmark-edge'>Edge</span>
            </div>
        )}
        <div className='ckk-loader__bar'>
            <span />
            <span />
            <span />
            <span />
            <span />
        </div>
    </div>
);

export default CkkLoader;
