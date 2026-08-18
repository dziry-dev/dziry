import './app.css';
import { cn, Outlet, Window } from 'dziri';
import { Nav } from './Nav.tsx';
import { route } from './router.ts';
import { isLight } from './state.ts';

export default function Main() {
    return (
        <Window
            title="dziri — compiled UI"
            width={1040}
            height={700}
            minWidth={520}
            minHeight={400}
            route={route}
            className={cn({ light: isLight })}
        >
            <div className="flex flex-col grow gap-6 p-6">
                <Nav />
                <div className="flex flex-col grow gap-6">
                    <Outlet />
                </div>
            </div>
        </Window>
    );
}
