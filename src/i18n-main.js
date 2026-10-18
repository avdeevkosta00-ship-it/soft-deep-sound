'use strict';
// Main-process strings (dialogs, download/search errors). The renderer tells us the language.
const DICT = {
  ru: {
    'dlg.folder': 'Папка с музыкой', 'dlg.files': 'Добавить треки', 'dlg.audio': 'Аудио',
    'dlg.cover': 'Выберите обложку', 'dlg.images': 'Изображения', 'dlg.bg': 'Выберите фон', 'dlg.dl': 'Куда сохранять загрузки', 'dlg.bgFiles': 'Картинки и видео',
    'err.format': 'Неподдерживаемый формат', 'err.big20': 'Изображение больше 20 МБ',
    'err.https': 'Разрешены только https-ссылки', 'err.addr': 'Недопустимый адрес источника',
    'err.status': 'Источник ответил {0}', 'err.notAudio': 'Это не аудиофайл ({0})', 'err.tooBig': 'Файл слишком большой',
    'err.sniff': 'Содержимое не похоже на аудио — файл отклонён', 'err.site': 'Сайт ответил {0}',
    'err.nothing': 'По ссылке нет ни страницы, ни аудиофайла',
    'dlg.export': 'Сохранить обработанную версию', 'dlg.wav': 'WAV — без потерь', 'dlg.mp3': 'MP3 — 320 kbps',
    'tray.play': 'Играть', 'tray.pause': 'Пауза', 'tray.next': 'Следующий трек', 'tray.prev': 'Предыдущий трек',
    'tray.vol': 'Громкость', 'tray.mute': 'Без звука / со звуком', 'tray.show': 'Открыть плеер', 'tray.hide': 'Свернуть в трей',
    'tray.sleep': 'Таймер сна', 'tray.sleepOn': 'Таймер сна — до {0}', 'tray.min': 'Через {0} мин', 'tray.sleepEnd': 'В конце трека', 'tray.sleepOff': 'Выключить таймер',
    'tray.autostart': 'Запускать вместе с Windows',
    'dlg.replace': 'Заменить', 'dlg.cancel': 'Отмена', 'dlg.exists': 'Файл «{0}» уже существует. Заменить его?',
    'tray.closeToTray': 'Закрывать в трей', 'tray.quit': 'Выйти', 'tray.nothing': 'Ничего не играет',
    'tray.hint': 'Плеер продолжает работать в трее. Нажмите на значок, чтобы открыть, или правой кнопкой — для управления.',
    'untitled': 'Без названия', 'seePage': 'См. страницу', 'audio': 'Аудио'
  },
  en: {
    'dlg.folder': 'Music folder', 'dlg.files': 'Add tracks', 'dlg.audio': 'Audio',
    'dlg.cover': 'Choose artwork', 'dlg.images': 'Images', 'dlg.bg': 'Choose a background', 'dlg.dl': 'Where to save downloads', 'dlg.bgFiles': 'Images and videos',
    'err.format': 'Unsupported format', 'err.big20': 'Image is larger than 20 MB',
    'err.https': 'Only https links are allowed', 'err.addr': 'Source address not allowed',
    'err.status': 'Source responded {0}', 'err.notAudio': 'Not an audio file ({0})', 'err.tooBig': 'File is too large',
    'err.sniff': "Content doesn't look like audio — file rejected", 'err.site': 'Site responded {0}',
    'err.nothing': 'The link is neither a page nor an audio file',
    'dlg.export': 'Save processed version', 'dlg.wav': 'WAV — lossless', 'dlg.mp3': 'MP3 — 320 kbps',
    'tray.play': 'Play', 'tray.pause': 'Pause', 'tray.next': 'Next track', 'tray.prev': 'Previous track',
    'tray.vol': 'Volume', 'tray.mute': 'Mute / unmute', 'tray.show': 'Open player', 'tray.hide': 'Hide to tray',
    'tray.sleep': 'Sleep timer', 'tray.sleepOn': 'Sleep timer — until {0}', 'tray.min': 'In {0} min', 'tray.sleepEnd': 'At the end of the track', 'tray.sleepOff': 'Turn timer off',
    'tray.autostart': 'Start with Windows',
    'dlg.replace': 'Replace', 'dlg.cancel': 'Cancel', 'dlg.exists': '“{0}” already exists. Replace it?',
    'tray.closeToTray': 'Close to tray', 'tray.quit': 'Quit', 'tray.nothing': 'Nothing playing',
    'tray.hint': 'The player keeps running in the tray. Click the icon to open it, right-click for controls.',
    'untitled': 'Untitled', 'seePage': 'See page', 'audio': 'Audio'
  }
};
let lang = 'ru';
const setLang = (l) => { if (DICT[l]) lang = l; };
const tm = (key, ...args) => String((DICT[lang] || DICT.ru)[key] ?? key).replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');
module.exports = { tm, setLang };
