import CkkLoader from './ckk-loader';
import './chunk-loader.scss';

export default function ChunkLoader({ message }: { message: string }) {
    return (
        <div className='ckk-tab-loader'>
            <CkkLoader with_wordmark />
            <p className='ckk-tab-loader__msg'>{message}</p>
        </div>
    );
}
