import express from 'express'
import mysql from 'mysql2/promise'
import { body, param, query, validationResult } from 'express-validator'

const app = express()


let db = null;

// La conexión usa las credenciales provistas por variables de entorno.
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

// La API no define filtros ni opciones por query string.
const validarQueryVacia = [
    query().custom((value) => Object.keys(value).length === 0)
        .withMessage('Este recurso no acepta parámetros de consulta')
]

// En altas y modificaciones solo se aceptan las medidas del rectángulo.
const validarRectangulo = [
    body().custom((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('El cuerpo debe ser un objeto JSON')
        }

        const camposPermitidos = ['base', 'altura']
        if (Object.keys(value).some((campo) => !camposPermitidos.includes(campo))) {
            throw new Error('Solo se permiten los campos base y altura')
        }

        const base = Number(value.base)
        const altura = Number(value.altura)
        // Evita guardar Infinity si las medidas son demasiado grandes.
        if (
            Number.isFinite(base) &&
            base > 0 &&
            Number.isFinite(altura) &&
            altura > 0 &&
            (!Number.isFinite(2 * (base + altura)) || !Number.isFinite(base * altura))
        ) {
            throw new Error('Los lados exceden el rango numérico permitido para calcular los resultados')
        }

        return true
    }),
    body('base')
        .exists()
        .withMessage('La base es obligatoria')
        .bail()
        .isFloat({ gt: 0 })
        .withMessage('La base debe ser un número mayor que cero')
        .toFloat(),
    body('altura')
        .exists()
        .withMessage('La altura es obligatoria')
        .bail()
        .isFloat({ gt: 0 })
        .withMessage('La altura debe ser un número mayor que cero')
        .toFloat()
]

// El identificador de la ruta debe coincidir con una clave válida.
const validarId = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('El id debe ser un entero positivo')
        .toInt()
]

// Centraliza la respuesta para cualquier dato que no supere las validaciones.
const responderErroresValidacion = (req, res, next) => {
    const errores = validationResult(req)
    if (!errores.isEmpty()) {
        return res.status(400).json({
            error: 'Solicitud inválida',
            detalles: errores.array().map(({ path, msg }) => ({ campo: path, mensaje: msg }))
        })
    }

    next()
}

app.use(validarQueryVacia, responderErroresValidacion)

// Devuelve todos los registros persistidos, ordenados para una respuesta estable.
app.get('/rectangulos', async (req, res) => {
    const [rectangulos] = await db.query(
        'SELECT id, base, altura, perimetro, superficie FROM rectangulos ORDER BY id'
    )

    res.json(rectangulos)
})

// Las consultas con parámetros enlazados evitan insertar el id directamente en SQL.
app.get('/rectangulos/:id', validarId, responderErroresValidacion, async (req, res) => {
    const [rectangulos] = await db.execute(
        'SELECT id, base, altura, perimetro, superficie FROM rectangulos WHERE id = ?',
        [req.params.id]
    )

    if (rectangulos.length === 0) {
        return res.status(404).json({ error: 'Rectángulo no encontrado' })
    }

    res.json(rectangulos[0])
})

// Crea el recurso y devuelve su ubicación junto con los datos guardados.
app.post('/rectangulos', validarRectangulo, responderErroresValidacion, async (req, res) => {
    const { base, altura } = req.body
    // Los valores derivados se calculan en el servidor, no se reciben del cliente.
    const perimetro = 2 * (base + altura)
    const superficie = base * altura

    const [resultado] = await db.execute(
        'INSERT INTO rectangulos (base, altura, perimetro, superficie) VALUES (?, ?, ?, ?)',
        [base, altura, perimetro, superficie]
    )

    const rectangulo = { id: resultado.insertId, base, altura, perimetro, superficie }
    res.location(`/rectangulos/${rectangulo.id}`).status(201).json(rectangulo)
})

// PUT reemplaza las medidas del rectángulo indicado y persiste los resultados recalculados.
app.put('/rectangulos/:id', validarId, validarRectangulo, responderErroresValidacion, async (req, res) => {
    const { base, altura } = req.body
    // Recalcular ambas propiedades mantiene los datos consistentes con los lados.
    const perimetro = 2 * (base + altura)
    const superficie = base * altura

    const [resultado] = await db.execute(
        'UPDATE rectangulos SET base = ?, altura = ?, perimetro = ?, superficie = ? WHERE id = ?',
        [base, altura, perimetro, superficie, req.params.id]
    )

    if (resultado.affectedRows === 0) {
        // MySQL puede reportar cero filas afectadas si el registro existe y no cambió.
        const [rectangulos] = await db.execute(
            'SELECT id FROM rectangulos WHERE id = ?',
            [req.params.id]
        )

        if (rectangulos.length === 0) {
            return res.status(404).json({ error: 'Rectángulo no encontrado' })
        }
    }

    res.json({ id: Number(req.params.id), base, altura, perimetro, superficie })
})

// DELETE responde sin cuerpo cuando elimina el recurso correctamente.
app.delete('/rectangulos/:id', validarId, responderErroresValidacion, async (req, res) => {
    const [resultado] = await db.execute(
        'DELETE FROM rectangulos WHERE id = ?',
        [req.params.id]
    )

    if (resultado.affectedRows === 0) {
        return res.status(404).json({ error: 'Rectángulo no encontrado' })
    }

    res.status(204).end()
})

// Convierte JSON mal formado y fallos inesperados en respuestas HTTP explícitas.
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
