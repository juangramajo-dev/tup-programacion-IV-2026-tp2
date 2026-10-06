import express from 'express'
import mysql from 'mysql2/promise'
import { body, param, query, validationResult } from 'express-validator'

const app = express()

// Materias y calificaciones se consultan desde una única conexión reutilizable.
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

const mensajeCalificacionDuplicada = 'Ya existe una calificación para ese alumno y materia'
const mensajeMateriaDuplicada = 'Ya existe una materia con ese nombre'
const mensajeMateriaEnUso = 'No se puede eliminar una materia con calificaciones asociadas'

const validarId = [
    param('id')
        .isInt({ min: 1 }).withMessage('El id debe ser un entero positivo')
        .toInt()
]

const validarSinConsulta = [
    query().custom((value) => Object.keys(value).length === 0)
        .withMessage('Este recurso no acepta parámetros de consulta')
]

const validarConsultaCalificaciones = [
    query().custom((value) =>
        Object.keys(value).every((campo) => ['alumno', 'materiaId'].includes(campo))
    ).withMessage('Solo se permiten los filtros alumno y materiaId'),
    query('alumno')
        .optional()
        .isString().withMessage('El nombre del alumno debe ser texto')
        .bail()
        .trim()
        .notEmpty().withMessage('El nombre del alumno no puede estar vacío')
        .isLength({ max: 100 }).withMessage('El nombre del alumno no puede superar los 100 caracteres'),
    query('materiaId')
        .optional()
        .isInt({ min: 1 }).withMessage('materiaId debe ser un entero positivo')
        .toInt()
]

const validarMateria = [
    body().custom((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('El cuerpo debe ser un objeto JSON')
        }
        if (Object.keys(value).some((campo) => campo !== 'nombre')) {
            throw new Error('Solo se permite el campo nombre')
        }
        return true
    }),
    body('nombre')
        .exists().withMessage('El nombre de la materia es obligatorio')
        .bail()
        .isString().withMessage('El nombre de la materia debe ser texto')
        .bail()
        .trim()
        .notEmpty().withMessage('El nombre de la materia no puede estar vacío')
        .isLength({ max: 100 }).withMessage('El nombre de la materia no puede superar los 100 caracteres')
]

const validarCalificacion = (excluirId = false) => [
    body().custom((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('El cuerpo debe ser un objeto JSON')
        }
        if (Object.keys(value).some((campo) => !['alumno', 'materiaId', 'notas'].includes(campo))) {
            throw new Error('Solo se permiten los campos alumno, materiaId y notas')
        }
        return true
    }),
    body('alumno')
        .exists().withMessage('El nombre del alumno es obligatorio')
        .bail()
        .isString().withMessage('El nombre del alumno debe ser texto')
        .bail()
        .trim()
        .notEmpty().withMessage('El nombre del alumno no puede estar vacío')
        .isLength({ max: 100 }).withMessage('El nombre del alumno no puede superar los 100 caracteres'),
    body('materiaId')
        .exists().withMessage('materiaId es obligatorio')
        .bail()
        .isInt({ min: 1 }).withMessage('materiaId debe ser un entero positivo')
        .toInt()
        .bail()
        .custom(async (materiaId) => {
            // Evita aceptar una clave foránea que no corresponda a una materia existente.
            const [materias] = await db.execute(
                'SELECT id FROM materias WHERE id = ?',
                [materiaId]
            )
            if (materias.length === 0) {
                throw new Error('La materia indicada no existe')
            }
            return true
        }),
    body('notas')
        .isArray({ min: 3, max: 3 })
        .withMessage('Se deben informar exactamente tres notas'),
    body('notas.*')
        .custom((nota) => typeof nota === 'number' && Number.isFinite(nota) && nota >= 0 && nota <= 10)
        .withMessage('Cada nota debe ser un número entre 0 y 10'),
    body('alumno').custom(async (alumno, { req }) => {
        const { materiaId } = req.body
        if (typeof alumno !== 'string' || typeof materiaId === 'undefined') {
            return true
        }

        const parametros = [alumno, materiaId]
        let sql = 'SELECT id FROM calificaciones WHERE alumno = ? AND materia_id = ?'
        if (excluirId) {
            // En una modificación, se excluye el registro actual al verificar unicidad.
            sql += ' AND id <> ?'
            parametros.push(req.params.id)
        }
        sql += ' LIMIT 1'

        const [calificaciones] = await db.execute(sql, parametros)
        if (calificaciones.length > 0) {
            throw new Error(mensajeCalificacionDuplicada)
        }
        return true
    })
]

const responderErroresValidacion = (req, res, next) => {
    const errores = validationResult(req)
    if (!errores.isEmpty()) {
        const detalles = errores.array().map(({ path, msg }) => ({ campo: path, mensaje: msg }))
        const esConflicto = detalles.some(({ mensaje }) =>
            [mensajeCalificacionDuplicada, mensajeMateriaDuplicada].includes(mensaje)
        )

        return res.status(esConflicto ? 409 : 400).json({
            error: esConflicto ? 'Conflicto con un recurso existente' : 'Solicitud inválida',
            detalles
        })
    }

    next()
}

const responderCalificacion = (fila) => ({
    id: fila.id,
    alumno: fila.alumno,
    materia: { id: fila.materia_id, nombre: fila.materia },
    notas: [Number(fila.nota1), Number(fila.nota2), Number(fila.nota3)]
})

app.get('/materias', validarSinConsulta, responderErroresValidacion, async (req, res) => {
    const [materias] = await db.execute(
        'SELECT id, nombre FROM materias ORDER BY id'
    )
    res.json(materias)
})

app.get('/materias/:id', validarId, validarSinConsulta, responderErroresValidacion, async (req, res) => {
    const [materias] = await db.execute(
        'SELECT id, nombre FROM materias WHERE id = ?',
        [req.params.id]
    )

    if (materias.length === 0) {
        return res.status(404).json({ error: 'Materia no encontrada' })
    }
    res.json(materias[0])
})

app.post('/materias', validarSinConsulta, validarMateria, responderErroresValidacion, async (req, res) => {
    const { nombre } = req.body
    try {
        const [resultado] = await db.execute(
            'INSERT INTO materias (nombre) VALUES (?)',
            [nombre]
        )
        const materia = { id: resultado.insertId, nombre }
        return res.location(`/materias/${materia.id}`).status(201).json(materia)
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: mensajeMateriaDuplicada })
        }
        throw error
    }
})

app.put('/materias/:id', validarId, validarSinConsulta, validarMateria, responderErroresValidacion, async (req, res) => {
    try {
        const [resultado] = await db.execute(
            'UPDATE materias SET nombre = ? WHERE id = ?',
            [req.body.nombre, req.params.id]
        )

        if (resultado.affectedRows === 0) {
            const [existentes] = await db.execute(
                'SELECT id FROM materias WHERE id = ?',
                [req.params.id]
            )
            if (existentes.length === 0) {
                return res.status(404).json({ error: 'Materia no encontrada' })
            }
        }

        res.json({ id: Number(req.params.id), nombre: req.body.nombre })
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: mensajeMateriaDuplicada })
        }
        throw error
    }
})

app.delete('/materias/:id', validarId, validarSinConsulta, responderErroresValidacion, async (req, res) => {
    try {
        const [resultado] = await db.execute(
            'DELETE FROM materias WHERE id = ?',
            [req.params.id]
        )
        if (resultado.affectedRows === 0) {
            return res.status(404).json({ error: 'Materia no encontrada' })
        }
        res.status(204).end()
    } catch (error) {
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: mensajeMateriaEnUso })
        }
        throw error
    }
})

app.get('/calificaciones', validarConsultaCalificaciones, responderErroresValidacion, async (req, res) => {
    let sql = `SELECT c.id, c.alumno, c.materia_id, m.nombre AS materia,
                      c.nota1, c.nota2, c.nota3
               FROM calificaciones c
               JOIN materias m ON m.id = c.materia_id`
    const condiciones = []
    const parametros = []

    if (req.query.alumno) {
        condiciones.push('c.alumno = ?')
        parametros.push(req.query.alumno)
    }
    if (req.query.materiaId) {
        condiciones.push('c.materia_id = ?')
        parametros.push(req.query.materiaId)
    }
    if (condiciones.length > 0) {
        sql += ` WHERE ${condiciones.join(' AND ')}`
    }
    sql += ' ORDER BY c.id'

    const [filas] = await db.execute(sql, parametros)
    res.json(filas.map(responderCalificacion))
})

app.get('/calificaciones/:id', validarId, validarSinConsulta, responderErroresValidacion, async (req, res) => {
    const [filas] = await db.execute(
        `SELECT c.id, c.alumno, c.materia_id, m.nombre AS materia,
                c.nota1, c.nota2, c.nota3
         FROM calificaciones c
         JOIN materias m ON m.id = c.materia_id
         WHERE c.id = ?`,
        [req.params.id]
    )

    if (filas.length === 0) {
        return res.status(404).json({ error: 'Calificación no encontrada' })
    }
    res.json(responderCalificacion(filas[0]))
})

app.post('/calificaciones', validarSinConsulta, validarCalificacion(), responderErroresValidacion, async (req, res) => {
    const { alumno, materiaId, notas } = req.body
    try {
        const [resultado] = await db.execute(
            'INSERT INTO calificaciones (alumno, materia_id, nota1, nota2, nota3) VALUES (?, ?, ?, ?, ?)',
            [alumno, materiaId, ...notas]
        )
        const [filas] = await db.execute(
            `SELECT c.id, c.alumno, c.materia_id, m.nombre AS materia,
                    c.nota1, c.nota2, c.nota3
             FROM calificaciones c JOIN materias m ON m.id = c.materia_id
             WHERE c.id = ?`,
            [resultado.insertId]
        )
        return res.location(`/calificaciones/${resultado.insertId}`)
            .status(201).json(responderCalificacion(filas[0]))
    } catch (error) {
        // El índice UNIQUE de la base también protege contra altas simultáneas.
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: mensajeCalificacionDuplicada })
        }
        throw error
    }
})

app.put('/calificaciones/:id', validarId, validarSinConsulta, validarCalificacion(true), responderErroresValidacion, async (req, res) => {
    const { alumno, materiaId, notas } = req.body
    try {
        const [resultado] = await db.execute(
            `UPDATE calificaciones
             SET alumno = ?, materia_id = ?, nota1 = ?, nota2 = ?, nota3 = ?
             WHERE id = ?`,
            [alumno, materiaId, ...notas, req.params.id]
        )

        if (resultado.affectedRows === 0) {
            // MySQL también informa cero cambios cuando los valores enviados ya estaban guardados.
            const [existentes] = await db.execute(
                'SELECT id FROM calificaciones WHERE id = ?',
                [req.params.id]
            )
            if (existentes.length === 0) {
                return res.status(404).json({ error: 'Calificación no encontrada' })
            }
        }

        const [filas] = await db.execute(
            `SELECT c.id, c.alumno, c.materia_id, m.nombre AS materia,
                    c.nota1, c.nota2, c.nota3
             FROM calificaciones c JOIN materias m ON m.id = c.materia_id
             WHERE c.id = ?`,
            [req.params.id]
        )
        res.json(responderCalificacion(filas[0]))
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: mensajeCalificacionDuplicada })
        }
        throw error
    }
})

app.delete('/calificaciones/:id', validarId, validarSinConsulta, responderErroresValidacion, async (req, res) => {
    const [resultado] = await db.execute(
        'DELETE FROM calificaciones WHERE id = ?',
        [req.params.id]
    )
    if (resultado.affectedRows === 0) {
        return res.status(404).json({ error: 'Calificación no encontrada' })
    }
    res.status(204).end()
})

app.use((error, res, ) => {
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
