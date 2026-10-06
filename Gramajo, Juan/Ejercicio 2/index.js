import express from 'express'
import mysql from 'mysql2/promise'
import { body, param, query, validationResult } from 'express-validator'


const app = express()
let db = null;

// Se conecta usando las credenciales de MySQL definidas en el entorno.
try {
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_DATABASE,
  });
  console.log("Conectado a la base de datos");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

app.use(express.json())

const mensajeNombreDuplicado = 'Ya existe una tarea con ese nombre'

// Solo se aceptan estos filtros para mantener explícitos los estados consultables.
const validarConsulta = [
    query().custom((value) =>
        Object.keys(value).every((campo) => campo === 'estado')
    ).withMessage('El único parámetro de consulta permitido es estado'),
    query('estado')
        .optional()
        .isIn(['completadas', 'pendientes'])
        .withMessage('El estado debe ser completadas o pendientes')
]

const validarId = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('El id debe ser un entero positivo')
        .toInt()
]

const validarCreacion = [
    body().custom((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('El cuerpo debe ser un objeto JSON')
        }
        if (Object.keys(value).some((campo) => !['nombre', 'estado'].includes(campo))) {
            throw new Error('Solo se permiten los campos nombre y estado')
        }
        return true
    }),
    body('nombre')
        .exists().withMessage('El nombre es obligatorio')
        .bail()
        .isString().withMessage('El nombre debe ser texto')
        .bail()
        .trim()
        .notEmpty().withMessage('El nombre no puede estar vacío')
        .isLength({ max: 100 }).withMessage('El nombre no puede superar los 100 caracteres')
        .bail()
        .custom(async (nombre) => {
            // La intercalación de la columna aplica la regla de comparación de nombres.
            const [coincidencias] = await db.execute(
                'SELECT id FROM tareas WHERE nombre = ? LIMIT 1',
                [nombre]
            )
            if (coincidencias.length > 0) {
                throw new Error(mensajeNombreDuplicado)
            }
            return true
        }),
    body('estado')
        .custom((value) => typeof value === 'boolean')
        .withMessage('estado debe ser un valor booleano true o false')
]

const validarActualizacion = [
    body().custom((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('El cuerpo debe ser un objeto JSON')
        }
        if (Object.keys(value).some((campo) => campo !== 'estado')) {
            throw new Error('Solo se permite el campo estado')
        }
        return true
    }),
    body('estado')
        .custom((value) => typeof value === 'boolean')
        .withMessage('estado debe ser un valor booleano true o false')
]

const responderErroresValidacion = (req, res, next) => {
    const errores = validationResult(req)
    if (!errores.isEmpty()) {
        const detalles = errores.array().map(({ path, msg }) => ({ campo: path, mensaje: msg }))
        const estadoHttp = detalles.some(({ mensaje }) => mensaje === mensajeNombreDuplicado)
            ? 409
            : 400

        return res.status(estadoHttp).json({
            error: estadoHttp === 409 ? mensajeNombreDuplicado : 'Solicitud inválida',
            detalles
        })
    }

    next()
}

// Normaliza el estado devuelto por MySQL a un booleano JSON.
const responderTarea = (fila) => ({
    id: fila.id,
    nombre: fila.nombre,
    estado: Boolean(fila.estado)
})

app.use(validarConsulta, responderErroresValidacion)

app.get('/tareas', async (req, res) => {
    let sql = 'SELECT id, nombre, estado FROM tareas'
    const parametros = []

    if (req.query.estado === 'completadas') {
        sql += ' WHERE estado = ?'
        parametros.push(true)
    } else if (req.query.estado === 'pendientes') {
        sql += ' WHERE estado = ?'
        parametros.push(false)
    }

    sql += ' ORDER BY id'
    const [filas] = await db.execute(sql, parametros)
    res.json(filas.map(responderTarea))
})

app.get('/tareas/:id', validarId, responderErroresValidacion, async (req, res) => {
    const [filas] = await db.execute(
        'SELECT id, nombre, estado FROM tareas WHERE id = ?',
        [req.params.id]
    )

    if (filas.length === 0) {
        return res.status(404).json({ error: 'Tarea no encontrada' })
    }

    res.json(responderTarea(filas[0]))
})

app.post('/tareas', validarCreacion, responderErroresValidacion, async (req, res) => {
    const { nombre, estado } = req.body

    try {
        const [resultado] = await db.execute(
            'INSERT INTO tareas (nombre, estado) VALUES (?, ?)',
            [nombre, estado]
        )
        const tarea = { id: resultado.insertId, nombre, estado }

        return res.location(`/tareas/${tarea.id}`).status(201).json(tarea)
    } catch (error) {
        // La restricción UNIQUE también evita duplicados ante dos altas simultáneas.
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: mensajeNombreDuplicado })
        }
        throw error
    }
})

app.patch('/tareas/:id', validarId, validarActualizacion, responderErroresValidacion, async (req, res) => {
    const [resultado] = await db.execute(
        'UPDATE tareas SET estado = ? WHERE id = ?',
        [req.body.estado, req.params.id]
    )

    if (resultado.affectedRows === 0) {
        // Cero filas modificadas también puede significar que el estado ya era igual.
        const [existentes] = await db.execute(
            'SELECT id FROM tareas WHERE id = ?',
            [req.params.id]
        )
        if (existentes.length === 0) {
            return res.status(404).json({ error: 'Tarea no encontrada' })
        }
    }

    const [filas] = await db.execute(
        'SELECT id, nombre, estado FROM tareas WHERE id = ?',
        [req.params.id]
    )
    res.json(responderTarea(filas[0]))
})

app.delete('/tareas/:id', validarId, responderErroresValidacion, async (req, res) => {
    const [resultado] = await db.execute(
        'DELETE FROM tareas WHERE id = ?',
        [req.params.id]
    )

    if (resultado.affectedRows === 0) {
        return res.status(404).json({ error: 'Tarea no encontrada' })
    }

    res.status(204).end()
})

app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'El cuerpo debe contener JSON válido' })
    }

    console.error(error)
    res.status(500).json({ error: 'Error interno del servidor' })
})

const iniciarServidor = async () => {
    // Comprueba que MySQL responda antes de aceptar solicitudes.
    await db.query('SELECT 1')

  app.listen(3000, () => {
    console.log("Servidor funcionando en el puerto 3000")
})
}

iniciarServidor().catch((error) => {
    console.error('No se pudo iniciar la API. Verifique la conexión y configuración de MySQL.', error)
    process.exitCode = 1
})
