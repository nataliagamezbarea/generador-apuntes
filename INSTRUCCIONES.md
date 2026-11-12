# Generador de apuntes

Aplicación local para crear y mejorar apuntes LaTeX con una IA local. La
interfaz está en español y no envía tus PDF a un proveedor de IA alojado. Los
iconos de la interfaz se cargan desde Font Awesome CDN y requieren conexión a
Internet.

Cada generación utiliza únicamente los archivos y el texto enviados en esa
solicitud, además de las fuentes web opcionales que se hayan pedido. La
estructura existente de temas se usa solo para organizar y numerar; los
apuntes anteriores no se incorporan como contenido. La sustitución de un
archivo requiere que el informe JSON registre tanto la fuente analizada como
el archivo generado.

## Iniciar el generador

### Primera vez

1. Instala y arranca Docker Engine/Desktop con Docker Compose y Buildx. El
   lanzador usa `sudo -n` solo para los comandos de Docker; la cuenta debe tener
   permiso para ejecutarlos sin una solicitud interactiva de contraseña.
   En equipos NVIDIA, Ollama puede aprovechar la GPU si Docker tiene instalado
   y configurado NVIDIA Container Toolkit; en este equipo ya está activado.
2. Desde el Escritorio, haz doble clic en **Generador de apuntes**. También
   puedes abrir la carpeta del proyecto y ejecutar el archivo
   `Generador de apuntes.desktop`.
3. En la página HTML de inicio, confirma la carpeta raíz que aparece o pulsa
   **Elegir otra carpeta**. Se abre el selector del sistema para escogerla; la
   ruta queda guardada en `.env`.
4. El acceso abre una página de carga, no una terminal. La página muestra el
   progreso de Docker y la descarga del modelo.
5. En el primer inicio, Docker descarga la imagen y prepara las herramientas
   para leer PDF y hacer OCR. Después Ollama descarga el modelo local con visión
   `qwen2.5vl:7b`, que ocupa varios GB. Hace falta Internet, espacio de disco y
   memoria; deja abierta la página mientras se completa. Al finalizar, se abre
   automáticamente el generador.
6. Se crea `.env` a partir de `.env.ejemplo`. `RUTA_APUNTES` guarda la carpeta
   elegida para los apuntes privados. También puedes cambiarla manualmente en
   `.env`.
   `PUERTO_WEB` configura el puerto web (por defecto, 8000).
   `NUM_CTX_IA` configura el contexto del modelo (por defecto, 24576 tokens).
   Los PDF se dividen en bloques más pequeños; si Ollama detecta un exceso de
   contexto o interrumpe la salida por repetición, el generador subdivide y
   reintenta automáticamente esa parte sin perder el material.
   `TOKENS_MAX_IA=-1` deja ilimitada la longitud de salida del modelo; el
   proceso sigue sujeto al tiempo de espera y a la memoria disponibles.
   `CONCURRENCIA_IA` permite hasta 50 llamadas simultáneas (por
   defecto, 1 para dar más estabilidad al procesar documentos largos); aumenta
   el valor en `.env` solo si tienes memoria suficiente.
   El máximo de 50 no acelera una petición individual y puede agotar la memoria;
   auméntalo solo después de comprobar el rendimiento del equipo.

### Siguientes veces

Haz doble clic en el acceso del Escritorio o en el archivo `.desktop` dentro de
la carpeta `generador-apuntes` y confirma o cambia la carpeta de apuntes. Docker
reutiliza la imagen y Ollama conserva el modelo descargado, así que no vuelve a
descargarlo si ya está instalado. Si eliges otra carpeta, el contenedor se
reinicia para montarla; los archivos de la carpeta anterior no se mueven ni se
borran.

También se puede iniciar desde una terminal, sin abrir el archivo `.desktop`:

```bash
cd ~/Escritorio/generador-apuntes
npm run iniciar
```

Para comprobar si el generador ya está disponible, abre la dirección indicada
por `PUERTO_WEB` en `.env`, normalmente <http://localhost:8000>.

Si Docker informa de que falta `buildx`, instala el complemento Docker Buildx y
vuelve a abrir el acceso. Si el puerto configurado ya está ocupado, cambia
`PUERTO_WEB` en `.env` por otro puerto libre.

Los apuntes LaTeX, informes y asignaturas se guardan bajo la ruta indicada en
`.env`. `RUTA_BIBLIOTECA_LATEX` sirve para elegir la carpeta de estilos LaTeX.
Puedes usar una ruta absoluta en `.env`; no hace falta mover tus apuntes ni
cambiar sus carpetas actuales. `BIBLIOTECA_LATEX_GITHUB` es el repositorio
público del que el generador lee directamente los fuentes `.tex`, sin clonar el
repositorio. Si la API de GitHub limita las consultas, lee los `.tex` desde el
ZIP público del repositorio, sin guardarlo ni clonarlo.

## Generar apuntes

Elige una asignatura, un tema y un apartado de sus listas, o selecciona **Crear**
para añadir uno nuevo con su nombre. Al crear una asignatura se prepara también
su carpeta privada y se conserva la selección para la próxima vez. Aporta PDF,
ZIP o archivos de código/texto.
Al crear tema o apartado, el número se asigna automáticamente y se conserva. La
IA propone un título descriptivo a partir del material y de la pista que hayas
escrito; en los resultados se muestran ambos números junto a sus títulos.
Para seleccionar una carpeta de proyecto, pulsa **Elegir carpeta** y escoge la
carpeta en el selector del navegador; se incluyen sus subcarpetas.
Los PDF se leen con Poppler; se conserva el texto y se envían al modelo local
con visión las imágenes incrustadas de tamaño significativo, no las máscaras de
transparencia ni los recursos gráficos diminutos. El OCR extrae rótulos de esas
imágenes y se agrupan hasta cuatro por petición. El código de los archivos del
proyecto también se entrega a la IA para que explique su propósito, estructura
y conceptos.
Puedes añadir archivos con el selector o arrastrándolos a la zona de fuentes.
Los archivos seleccionados y el texto pegado se guardan como borrador local en
el navegador y se restauran al recargar la página. Se conservan en el mismo
navegador y dirección hasta que los quites; el selector del sistema no puede
reabrirse automáticamente, pero los archivos restaurados quedan listos para
generar. Si el navegador no tiene espacio para guardar el borrador, la página
mostrará un aviso.

Si la selección incluye un ZIP, se usa un flujo por etapas: primero analiza y
guarda los apuntes derivados de los PDF; después divide el código en bloques con
sentido y clasifica cada bloque por su contenido para agruparlo con el tema y el
apartado adecuados. Omite las copias empaquetadas de Three.js y OrbitControls
dentro de `lib`, que son dependencias externas repetidas y no código del temario.
Para una entrada de texto muy corta, la extensión de los apuntes se ajusta al
material disponible en vez de añadir desarrollos, ejemplos o preguntas que no
estén justificados por la fuente.
Los resultados de cada bloque se guardan en un JSON de
progreso antes de avanzar. Si se interrumpe el proceso o se reinicia Docker,
vuelve a abrir la aplicación y pulsa **Reanudar** en la generación pendiente;
si la IA devuelve JSON sin apartados LaTeX válidos, se le solicita una vez que
corrija el formato antes de detener ese bloque. La generación normal aplica el
mismo reintento a cada parte del material. Los PDF ya escritos no se
vuelven a generar. Los directorios de trabajos sin archivo de estado se omiten
al listar las generaciones pendientes. Si activaste la sustitución, se
pedirá confirmación antes de reemplazar apuntes existentes en cada etapa.

La comparación busca apuntes `.tex` anteriores de la misma asignatura, en todos
sus temas; no mezcla contenidos de otras asignaturas. Cada generación escribe:

- Apuntes `.tex` dentro de la carpeta de la asignatura, tema y apartado.
- `informes-generacion/<asignatura>/tema-<n>-apartado-<n>/ultima-generacion.json`
  y `cobertura.json`, dentro del proyecto Generador y separados de los apuntes.

Si se vuelven a enviar los mismos archivos, consigna y opciones, se reconoce la
huella del material y se muestra el último informe sin volver a generar los
apuntes con la IA.

Los apuntes usan las macros reales de `bibliotecas_latex`, siguiendo la
estructura de los documentos WEC de referencia; no se sustituye la biblioteca
por una plantilla de LaTeX genérica. Se recomienda compilar con XeLaTeX y
`-shell-escape` según la configuración de la biblioteca.

La jerarquía de títulos reproduce WEC:
- `\secciongrande{...}`: título principal del archivo, con el color de sección.
- `\seccion{...}`: bloque de segundo nivel que también aparece como subsección
  en el índice general del tema.
- `\subtituloA{...}` y `\subtituloB{...}`: títulos internos y detalles
  subordinados, con la jerarquía visual y los colores de la biblioteca.
- `\resumen`, `\definicion`, `\definicionpar`, `\lista`, `\pasos`,
  `\nota`, `\alertas`, `\rectangulos`, `\tabla`, `\tablacab` y
  `\midrule`: componentes de contenido oficiales, según el caso.

El documento del tema crea un índice automático con `\tableofcontents`:
incluye los niveles `\secciongrande` y `\seccion`, igual que el WEC de
referencia, y deja `\subtituloA/B` como jerarquía interna para no saturarlo.
La compilación debe ejecutar las pasadas necesarias para actualizar el índice.
Los bloques de código conservan las líneas y la indentación; el preámbulo
alternará sus seis fondos y colores de resaltado según el encabezado WEC activo.
Las tablas comparativas usan la sintaxis oficial de la biblioteca.
En cada generación, el Generador consulta el árbol de
[`nataliagamezbarea/apuntes-latex`](https://github.com/nataliagamezbarea/apuntes-latex)
y descarga directamente desde GitHub los archivos `.tex` bajo
`bibliotecas_latex/`. Si la API devuelve un error de cuota, lee esos mismos
archivos desde el ZIP público de GitHub; no clona el repositorio ni guarda el
ZIP o fuentes binarias.
Añade al contexto de la IA sus rutas, documentación de uso y macros/entornos
detectados. `RUTA_BIBLIOTECA_LATEX` sigue apuntando a la biblioteca local
instalada que XeLaTeX necesita al compilar los apuntes generados; el generador
no crea ni actualiza esa copia local.
El prompt pide explicaciones desarrolladas de los conceptos, condiciones,
excepciones, diferencias y errores frecuentes; ejemplos originales y una
comprobación hecho por hecho para no dejar ideas relevantes solo mencionadas.
Si el material presupone conocimientos que no explica, pide añadir el contexto
necesario y distinguirlo de los datos de la fuente.
Los títulos se adaptan a las macros coloreadas de la biblioteca. La explicación
mantiene los hechos necesarios para estudiar, pero usa organización y redacción
propias en vez de copiar o sustituir el texto línea por línea. Comprueba los
apuntes resultantes frente al material y las exigencias de tu asignatura.

La investigación web es opcional. Al activarla, busca en la web general, sin
Wikipedia, a partir de los conceptos extraídos; no hace falta escribir un tema
de búsqueda. En una generación con ZIP, la búsqueda se aplica a los bloques PDF
que establecen el temario, no al código del ZIP. La IA recibe los títulos y
descripciones breves de los resultados junto con sus enlaces, y los puede usar
para ampliar los apuntes. La búsqueda usa Bing RSS para uso personal y no
comercial; si no está disponible o no encuentra fuentes, la generación continúa
con el material local.
Reescribir una fuente no concede permiso para redistribuir material protegido.
Revisa las fuentes, los apuntes y los conceptos pendientes; ninguna herramienta
puede prometer una nota concreta ni verificar un temario oficial que no se le
haya dado.

## Entender y mejorar un apunte

Pulsa **Revisar mis apuntes**. Elige asignatura y fichero `.tex`, selecciona el
texto que te cuesta entender y escribe qué necesitas. Si quieres, añade un PDF,
ZIP o código como material de apoyo. La IA propone una explicación y un cambio;
solo se guarda cuando revisas la propuesta y pulsas una de las acciones para
aplicarla. Si el apunte cambió entretanto, se avisa antes de sobrescribirlo.

## Organización

- `js/`: servidor, interfaz, lector de materiales, IA, apuntes, investigación,
  selección de archivos y pruebas. Los identificadores propios están en español;
  se conservan los nombres exigidos por las API y las bibliotecas.
- `interfaz/`: páginas HTML.
- `css/`: hojas de estilo de la aplicación y la pantalla de carga.
- `docker/`: configuración de Docker Compose e imagen de Node con Poppler/OCR.
- `.env.ejemplo`: ejemplo en español para crear el `.env` personal.
- `js/iniciar.js`: inicializa Docker, actualiza la página de carga y comprueba
  Ollama, el modelo y la web.
- `Generador de apuntes.desktop`: lanzador ejecutable incluido en este proyecto;
  hay otra copia en el Escritorio para abrirlo con doble clic.

Durante la generación, el panel muestra las etapas, el archivo o página que se
está leyendo, las partes que analiza la IA, el tiempo estimado y el botón para
detener el proceso. El material de texto se divide en partes para que la
generación no descarte el final al superar el contexto de una sola petición.
La IA actúa como profesora experta en la materia y explica con redacción y
estructura didáctica originales. Debe cubrir todos los conceptos y detalles
relevantes, pero no imitar el texto fuente ni hacer una paráfrasis oración por
oración; cambiar palabras no elimina derechos de autor.
Los PDF conservan el texto extraído directamente y las imágenes incrustadas de
tamaño significativo se extraen por separado y se procesan visualmente aunque
la página también tenga texto. Se descartan máscaras de transparencia y recursos
gráficos diminutos para no confundirlos con imágenes del material. Las imágenes
se agrupan hasta cuatro por petición. La IA valora si son relevantes, si se pueden explicar en texto propio o si son
decorativas. Si una imagen contiene texto legible, su contenido se incorpora
mediante OCR y la IA debe explicar todas sus ideas y datos relevantes con
redacción propia. Puede explicar la figura en palabras o sugerir una alternativa
con licencia reutilizable; no reutiliza la imagen fuente. El OCR se aplica a la
imagen extraída sin sustituir el texto del PDF. El tiempo restante se muestra
en segundos, minutos y horas. Cuando una foto aporte valor didáctico, se puede
añadir una imagen de Wikimedia Commons con licencia reutilizable; el apunte y
el informe guardan su autoría, licencia y enlace. No se reutilizan las imágenes
incluidas en los PDF como ilustraciones de salida.
Las imágenes ilustradas se agrupan en las peticiones. Se procesan en paralelo
con un máximo configurable de 50 llamadas y sus apuntes se combinan manteniendo
el orden original. El contexto de cada petición y los límites de subida
configurables en `.env` siguen dependiendo del modelo y de la memoria disponible.
El OCR puede fallar con letra manual, imágenes borrosas o diagramas sin texto
legible.
