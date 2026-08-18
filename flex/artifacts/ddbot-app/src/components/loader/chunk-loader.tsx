import './chunk-loader.scss';

export default function ChunkLoader({ message }: { message: string }) {
    return (
        <div className='ckk-tab-loader'>
            <div className='ckk-tab-loader__wordmark'>
                <span className='ckk-tab-loader__wordmark-ckk'>CKK</span>
                <span className='ckk-tab-loader__wordmark-edge'>Edge</span>
            </div>
            <div className='ckk-tab-loader__bar'>
                <span /><span /><span /><span /><span />
            </div>
            <p className='ckk-tab-loader__msg'>{message}</p>
        </div>
    );
}
