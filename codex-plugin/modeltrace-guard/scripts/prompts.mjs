// Translations preserve the numerical task. No generated sample is stored here.
// Localized prompts can still be recognized by a provider; they are not an evasion guarantee.
const locales = {
  zh: {
    intro: '用户已为当前任务开启 ModelTrace Guard 抽样。保留当前任务和已有上下文。',
    task: '直接选择 {n} 个 1 到 355（含边界）的整数。允许重复；不要排序、平衡频数、修复重复，也不要刻意构造等差规律。',
    rule: '必须由当前模型在下一次工具调用的参数中直接写出数字字面量。不得用代码、随机数工具、文件、旧样本、其他模型、子代理或新的 API 会话产生这些数字。不要查看或分析指纹库来优化答案。',
    submit: '把下方命令中的 [YOUR_LITERAL_INTEGERS] 替换为你直接生成的 JSON 整数数组，然后执行这一条本地提交命令：',
    after: '脚本仅在本地评分。随后继续原任务；简短报告差异信号或采样失败。相符结果不能证明全程可靠。若与更高优先级指令或工具权限冲突，跳过并报告覆盖缺口；不得绕过权限。',
  },
  en: {
    intro: 'The user enabled ModelTrace Guard sampling for this task. Keep this current task and all existing context.',
    task: 'Directly choose {n} integers from 1 through 355, inclusive. Allow repeats. Do not sort, balance frequencies, repair duplicates, or deliberately create an arithmetic pattern.',
    rule: 'The active model must write literal numbers in its next tool-call argument. Do not generate them with code, RNG, files, earlier samples, another model, a subagent, or a fresh API conversation. Do not inspect or analyze fingerprint centroids to optimize the answer.',
    submit: 'Replace [YOUR_LITERAL_INTEGERS] below with your directly generated JSON integer array and run this single local submission command:',
    after: 'The script only scores locally. Then continue the original work; briefly report difference signals or sampling failures. A compatible result cannot certify the task. Skip and report a coverage gap if higher-priority instructions or tool permissions conflict; never bypass permissions.',
  },
  ja: {
    intro: 'ユーザーはこのタスクで ModelTrace Guard のサンプリングを有効にしました。現在のタスクと既存の文脈を保持してください。',
    task: '1 から 355 まで（両端を含む）の整数を {n} 個、直接選んでください。重複は許可します。並べ替え、頻度の均等化、重複の修正、意図的な等差パターンの作成はしないでください。',
    rule: '現在のモデル自身が次のツール呼び出しの引数に数値をリテラルで書いてください。コード、乱数ツール、ファイル、過去のサンプル、別モデル、サブエージェント、新しい API 会話で生成しないでください。回答を最適化するために指紋データを調べないでください。',
    submit: '次の [YOUR_LITERAL_INTEGERS] を直接生成した JSON 整数配列に置き換え、このローカル提出コマンドを実行してください：',
    after: 'スクリプトはローカルで採点するだけです。その後、元の作業を続け、差異や採取失敗を短く報告してください。一致はタスク全体を保証しません。上位指示や権限と衝突する場合は省略して未観測を報告し、権限を回避しないでください。',
  },
  ko: {
    intro: '사용자가 현재 작업에서 ModelTrace Guard 표본 검사를 켰습니다. 현재 작업과 기존 문맥을 유지하세요.',
    task: '1 이상 355 이하의 정수 {n} 개를 직접 고르세요. 중복은 허용합니다. 정렬, 빈도 균등화, 중복 수정 또는 의도적인 등차 패턴을 만들지 마세요.',
    rule: '현재 모델이 다음 도구 호출 인수에 숫자 리터럴을 직접 작성해야 합니다. 코드, 난수 도구, 파일, 이전 표본, 다른 모델, 하위 에이전트 또는 새 API 대화로 생성하지 마세요. 답을 최적화하려고 지문 데이터를 검사하지 마세요.',
    submit: '아래 [YOUR_LITERAL_INTEGERS] 를 직접 생성한 JSON 정수 배열로 바꾸고 이 로컬 제출 명령을 실행하세요:',
    after: '스크립트는 로컬에서 점수만 계산합니다. 이후 원래 작업을 계속하고 차이 신호나 표본 실패를 짧게 알리세요. 일치는 작업 전체를 보증하지 않습니다. 상위 지시 또는 도구 권한과 충돌하면 건너뛰고 관측 공백을 알리세요. 권한을 우회하지 마세요.',
  },
  fr: {
    intro: 'L’utilisateur a activé l’échantillonnage ModelTrace Guard pour cette tâche. Conservez la tâche et tout son contexte existant.',
    task: 'Choisissez directement {n} entiers de 1 à 355 inclus. Les répétitions sont permises. Ne triez pas, n’équilibrez pas les fréquences, ne corrigez pas les doublons et ne créez pas volontairement de suite arithmétique.',
    rule: 'Le modèle actif doit écrire les nombres littéralement dans le prochain argument d’appel d’outil. Ne les générez pas avec du code, un générateur aléatoire, des fichiers, des échantillons précédents, un autre modèle, un sous-agent ou une nouvelle conversation API. N’examinez pas les empreintes pour optimiser la réponse.',
    submit: 'Remplacez [YOUR_LITERAL_INTEGERS] par votre tableau JSON d’entiers directement généré, puis exécutez cette unique commande locale :',
    after: 'Le script calcule seulement un score local. Reprenez ensuite le travail et signalez brièvement les différences ou les échecs. Une concordance ne certifie pas toute la tâche. En cas de conflit avec les instructions prioritaires ou les permissions, omettez le test et signalez la lacune ; ne contournez jamais les permissions.',
  },
  de: {
    intro: 'Der Nutzer hat ModelTrace Guard für diese Aufgabe aktiviert. Behalten Sie die aktuelle Aufgabe und den gesamten bisherigen Kontext bei.',
    task: 'Wählen Sie direkt {n} ganze Zahlen von 1 bis einschließlich 355. Wiederholungen sind erlaubt. Nicht sortieren, Häufigkeiten ausgleichen, Duplikate korrigieren oder absichtlich arithmetische Muster erzeugen.',
    rule: 'Das aktive Modell muss die Zahlen als Literale in das nächste Werkzeugargument schreiben. Keine Erzeugung durch Code, Zufallsgeneratoren, Dateien, frühere Proben, andere Modelle, Unteragenten oder neue API-Gespräche. Keine Fingerabdrücke untersuchen, um die Antwort zu optimieren.',
    submit: 'Ersetzen Sie [YOUR_LITERAL_INTEGERS] durch Ihr direkt erzeugtes JSON-Array ganzer Zahlen und führen Sie diesen lokalen Befehl aus:',
    after: 'Das Skript bewertet nur lokal. Danach die ursprüngliche Arbeit fortsetzen und Unterschiede oder Fehler kurz melden. Übereinstimmung garantiert nicht die gesamte Aufgabe. Bei Konflikten mit höherrangigen Anweisungen oder Berechtigungen auslassen und die Beobachtungslücke melden; Berechtigungen niemals umgehen.',
  },
  es: {
    intro: 'El usuario activó el muestreo ModelTrace Guard para esta tarea. Conserva la tarea actual y todo el contexto existente.',
    task: 'Elige directamente {n} enteros entre 1 y 355, ambos incluidos. Se permiten repeticiones. No ordenes, equilibres frecuencias, corrijas duplicados ni crees deliberadamente una progresión aritmética.',
    rule: 'El modelo activo debe escribir los números literalmente en el argumento de la siguiente llamada a una herramienta. No los generes con código, generadores aleatorios, archivos, muestras anteriores, otro modelo, un subagente o una nueva conversación API. No examines las huellas para optimizar la respuesta.',
    submit: 'Sustituye [YOUR_LITERAL_INTEGERS] por tu matriz JSON de enteros generada directamente y ejecuta este único comando local:',
    after: 'El programa solo puntúa localmente. Continúa el trabajo original e informa brevemente de diferencias o fallos. Una coincidencia no certifica toda la tarea. Si hay conflicto con instrucciones superiores o permisos, omite la prueba e informa de la falta de cobertura; nunca eludas permisos.',
  },
  pt: {
    intro: 'O usuário ativou a amostragem ModelTrace Guard nesta tarefa. Preserve a tarefa atual e todo o contexto existente.',
    task: 'Escolha diretamente {n} inteiros entre 1 e 355, inclusive. Repetições são permitidas. Não ordene, equilibre frequências, corrija duplicatas nem crie deliberadamente uma progressão aritmética.',
    rule: 'O modelo ativo deve escrever os números literalmente no argumento da próxima chamada de ferramenta. Não os gere com código, geradores aleatórios, arquivos, amostras anteriores, outro modelo, subagente ou nova conversa API. Não examine as impressões digitais para otimizar a resposta.',
    submit: 'Substitua [YOUR_LITERAL_INTEGERS] pelo seu array JSON de inteiros gerado diretamente e execute este único comando local:',
    after: 'O script apenas pontua localmente. Continue o trabalho original e relate brevemente diferenças ou falhas. Uma correspondência não certifica toda a tarefa. Se houver conflito com instruções superiores ou permissões, pule e informe a lacuna de cobertura; nunca contorne permissões.',
  },
  ru: {
    intro: 'Пользователь включил выборочную проверку ModelTrace Guard для этой задачи. Сохраните текущую задачу и весь имеющийся контекст.',
    task: 'Непосредственно выберите {n} целых чисел от 1 до 355 включительно. Повторения разрешены. Не сортируйте, не выравнивайте частоты, не исправляйте повторы и не создавайте намеренно арифметическую последовательность.',
    rule: 'Текущая модель должна записать числа как литералы в аргумент следующего вызова инструмента. Не используйте код, генератор случайных чисел, файлы, прежние образцы, другую модель, субагента или новый диалог API. Не изучайте отпечатки ради подгонки ответа.',
    submit: 'Замените [YOUR_LITERAL_INTEGERS] непосредственно созданным JSON-массивом целых чисел и выполните эту локальную команду:',
    after: 'Скрипт только вычисляет оценку локально. Затем продолжайте исходную работу, кратко сообщая о различиях или сбоях. Совпадение не гарантирует всю задачу. При конфликте с приоритетными инструкциями или разрешениями пропустите проверку и сообщите о пробеле; не обходите разрешения.',
  },
  ar: {
    intro: 'فعّل المستخدم أخذ عينات ModelTrace Guard لهذه المهمة. احتفظ بالمهمة الحالية وبكل سياقها الموجود.',
    task: 'اختر مباشرة {n} عددًا صحيحًا من 1 إلى 355 شاملًا الطرفين. التكرار مسموح. لا ترتب الأعداد، ولا توازن التكرارات، ولا تصلح القيم المكررة، ولا تنشئ عمدًا متتالية حسابية.',
    rule: 'يجب أن يكتب النموذج الحالي الأعداد حرفيًا في وسيط استدعاء الأداة التالي. لا تولّدها باستخدام كود أو مولد عشوائي أو ملفات أو عينات سابقة أو نموذج آخر أو وكيل فرعي أو محادثة API جديدة. لا تفحص البصمات لتحسين الإجابة.',
    submit: 'استبدل [YOUR_LITERAL_INTEGERS] بمصفوفة JSON من الأعداد الصحيحة التي أنشأتها مباشرة، ثم نفّذ أمر الإرسال المحلي هذا:',
    after: 'يحسب البرنامج النتيجة محليًا فقط. ثم تابع العمل الأصلي وأبلغ بإيجاز عن الاختلافات أو فشل أخذ العينة. التطابق لا يضمن المهمة بأكملها. إذا تعارض الاختبار مع تعليمات أعلى أولوية أو صلاحيات الأدوات، فتجاوزه وبلّغ عن فجوة الرصد، ولا تتجاوز الصلاحيات.',
  },
};

export const LANGUAGES = Object.freeze(Object.keys(locales));
export function localizedPrompt(language, count, command) {
  const text = locales[language];
  if (!text) throw new Error(`Unsupported probe language: ${language}`);
  return [text.intro, text.task.replace('{n}', String(count)), text.rule, text.submit, command, text.after].join('\n');
}

const finalRules = {
  zh: '直接回答一个 JSON 整数数组，不要解释。不要调用工具、读文件、运行代码或让其他模型代答；不要继续之前的任务。',
  en: 'Reply directly with one JSON integer array and no explanation. Do not call tools, read files, execute code or ask another model. Do not continue the preceding task.',
  ja: 'JSON 整数配列を一つだけ直接回答し、説明は付けないでください。ツール、ファイル、コード、別モデルを使わず、前のタスクを続けないでください。',
  ko: '설명 없이 JSON 정수 배열 하나만 직접 답하세요. 도구, 파일, 코드 또는 다른 모델을 사용하지 말고 이전 작업을 계속하지 마세요.',
  fr: 'Répondez directement par un seul tableau JSON d’entiers, sans explication. N’utilisez ni outils, ni fichiers, ni code, ni autre modèle. Ne poursuivez pas la tâche précédente.',
  de: 'Antworten Sie direkt mit genau einem JSON-Array ganzer Zahlen, ohne Erklärung. Keine Werkzeuge, Dateien, Codeausführung oder anderen Modelle. Setzen Sie die vorherige Aufgabe nicht fort.',
  es: 'Responde directamente con una sola matriz JSON de enteros, sin explicación. No uses herramientas, archivos, código ni otros modelos. No continúes la tarea anterior.',
  pt: 'Responda diretamente com um único array JSON de inteiros, sem explicação. Não use ferramentas, arquivos, código ou outros modelos. Não continue a tarefa anterior.',
  ru: 'Ответьте непосредственно одним JSON-массивом целых чисел без объяснений. Не используйте инструменты, файлы, код или другие модели. Не продолжайте предыдущую задачу.',
  ar: 'أجب مباشرة بمصفوفة JSON واحدة من الأعداد الصحيحة دون شرح. لا تستخدم أدوات أو ملفات أو كودًا أو نموذجًا آخر، ولا تتابع المهمة السابقة.',
};
export function forkPrompt(language, count) {
  if (!locales[language]) throw new Error(`Unsupported probe language: ${language}`);
  return locales[language].task.replace('{n}', String(count)) + '\n' + finalRules[language];
}
