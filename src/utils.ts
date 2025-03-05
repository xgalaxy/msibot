import { ChildProcess, spawn } from 'child_process'

export function addUrlCacheBuster(urlString: string): string {
    const url = new URL(urlString);
    const params = new URLSearchParams(url.search);
    params.set('nocache', Date.now().toString());
    url.search = params.toString();
    return url.toString();
}

export function normalizeUrl(url: string): string {
    return url.split('?')[0];
}

export function shuffleArray<T>(array: T[]): T[] {
    const shuffledArray = [...array];
    for (let i = shuffledArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
    }

    return shuffledArray;
}

export function getRandom(min = 1000, max = 5000): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function playSound(soundFile: string): ChildProcess | null {
    let command: string;
    let args: string[];

    if (process.platform === 'darwin') {
        command = 'afplay';
        args = [soundFile];
    } else if (process.platform === 'win32') {
        // FIXME: sound isn't working in windows
        const presentationCore = 'Add-Type -AssemblyName presentationCore;';
        const mediaPlayer = '$player = New-Object system.windows.media.mediaplayer;';
        const loadAudio = (path: string) => `$player.open("${path}");`;
        const playAudio = '$player.Play();';
        const stopAudio = 'Start-Sleep 1; Start-Sleep -s $player.NaturalDuration.TimeSpan.TotalSeconds;Exit;';

        command = 'powershell';
        args = ['-c', `${presentationCore} ${mediaPlayer} ${loadAudio(soundFile)} ${playAudio} ${stopAudio}`];
    } else {
        console.warn('[system] unsupported platform for playing sounds');
        return null;
    }

    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
}
