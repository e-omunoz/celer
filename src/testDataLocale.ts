// The word lists the test data generator (testData.ts) draws from, per locale: names, places, companies, products,
// statuses. Spanish by default. Places carry their province and the first digits of their postal codes, so a row's
// city, province and postal code agree. E-mail and web domains are reserved for examples (RFC 2606 / RFC 6761): test
// data never names a real mailbox or site.

export type Locale = "es" | "en";

export interface Place {
  city: string;
  province: string;
  /** First digits of its postal codes (Spain: the province's two; US: the ZIP's first three). */
  postal: string;
}

export interface LocaleData {
  male: string[];
  female: string[];
  surnames: string[];
  places: Place[];
  /** Street types (es) or suffixes (en). */
  streetTypes: string[];
  streets: string[];
  countries: { name: string; iso2: string; iso3: string; weight: number }[];
  companyWords: string[];
  companySuffixes: string[];
  productNouns: string[];
  productAdjectives: string[];
  statuses: string[];
  domains: string[];
}

const ES: LocaleData = {
  male: [
    "Antonio", "José", "Manuel", "Francisco", "David", "Juan", "Javier", "Daniel", "Carlos", "Alejandro", "Miguel", "Rafael",
    "Pablo", "Pedro", "Ángel", "Sergio", "Fernando", "Jorge", "Luis", "Alberto", "Álvaro", "Adrián", "Diego", "Raúl",
    "Iván", "Rubén", "Enrique", "Óscar", "Ramón", "Andrés", "Hugo", "Mario", "Marcos", "Íker", "Jaime", "Gonzalo",
  ],
  female: [
    "María", "Carmen", "Ana", "Isabel", "Laura", "Cristina", "Marta", "Lucía", "Elena", "Paula", "Sara", "Raquel",
    "Pilar", "Rosa", "Beatriz", "Silvia", "Patricia", "Nuria", "Andrea", "Irene", "Alba", "Sofía", "Julia", "Claudia",
    "Noelia", "Rocío", "Lorena", "Eva", "Inés", "Teresa", "Montserrat", "Begoña", "Ainhoa", "Nerea", "Lidia", "Míriam",
  ],
  surnames: [
    "García", "Rodríguez", "González", "Fernández", "López", "Martínez", "Sánchez", "Pérez", "Gómez", "Martín", "Jiménez",
    "Ruiz", "Hernández", "Díaz", "Moreno", "Muñoz", "Álvarez", "Romero", "Alonso", "Gutiérrez", "Navarro", "Torres",
    "Domínguez", "Vázquez", "Ramos", "Gil", "Ramírez", "Serrano", "Blanco", "Molina", "Morales", "Suárez", "Ortega",
    "Delgado", "Castro", "Ortiz", "Rubio", "Marín", "Sanz", "Núñez", "Iglesias", "Medina", "Garrido", "Cortés",
    "Castillo", "Santos", "Lozano", "Guerrero", "Cano", "Prieto", "Méndez", "Cruz", "Calvo", "Gallego", "Vidal",
    "León", "Márquez", "Herrera", "Peña", "Flores", "Cabrera", "Campos", "Vega", "Fuentes", "Carrasco", "Diez",
    "Aguilar", "Nieto", "Pascual", "Soler", "Ibáñez", "Arias", "Santana", "Ferrer", "Echevarría", "Sáez",
  ],
  places: [
    { city: "Madrid", province: "Madrid", postal: "28" }, { city: "Alcalá de Henares", province: "Madrid", postal: "28" },
    { city: "Móstoles", province: "Madrid", postal: "28" }, { city: "Barcelona", province: "Barcelona", postal: "08" },
    { city: "Sabadell", province: "Barcelona", postal: "08" }, { city: "Terrassa", province: "Barcelona", postal: "08" },
    { city: "Valencia", province: "Valencia", postal: "46" }, { city: "Gandía", province: "Valencia", postal: "46" },
    { city: "Sevilla", province: "Sevilla", postal: "41" }, { city: "Zaragoza", province: "Zaragoza", postal: "50" },
    { city: "Málaga", province: "Málaga", postal: "29" }, { city: "Marbella", province: "Málaga", postal: "29" },
    { city: "Murcia", province: "Murcia", postal: "30" }, { city: "Cartagena", province: "Murcia", postal: "30" },
    { city: "Palma", province: "Illes Balears", postal: "07" }, { city: "Las Palmas de Gran Canaria", province: "Las Palmas", postal: "35" },
    { city: "Bilbao", province: "Bizkaia", postal: "48" }, { city: "Alicante", province: "Alicante", postal: "03" },
    { city: "Elche", province: "Alicante", postal: "03" }, { city: "Córdoba", province: "Córdoba", postal: "14" },
    { city: "Valladolid", province: "Valladolid", postal: "47" }, { city: "Vigo", province: "Pontevedra", postal: "36" },
    { city: "Gijón", province: "Asturias", postal: "33" }, { city: "Oviedo", province: "Asturias", postal: "33" },
    { city: "A Coruña", province: "A Coruña", postal: "15" }, { city: "Santiago de Compostela", province: "A Coruña", postal: "15" },
    { city: "Vitoria-Gasteiz", province: "Araba", postal: "01" }, { city: "Granada", province: "Granada", postal: "18" },
    { city: "Reus", province: "Tarragona", postal: "43" }, { city: "Santa Cruz de Tenerife", province: "Santa Cruz de Tenerife", postal: "38" },
    { city: "Pamplona", province: "Navarra", postal: "31" }, { city: "Almería", province: "Almería", postal: "04" },
    { city: "San Sebastián", province: "Gipuzkoa", postal: "20" }, { city: "Burgos", province: "Burgos", postal: "09" },
    { city: "Albacete", province: "Albacete", postal: "02" }, { city: "Santander", province: "Cantabria", postal: "39" },
    { city: "Castellón de la Plana", province: "Castellón", postal: "12" }, { city: "Logroño", province: "La Rioja", postal: "26" },
    { city: "Badajoz", province: "Badajoz", postal: "06" }, { city: "Salamanca", province: "Salamanca", postal: "37" },
    { city: "Huelva", province: "Huelva", postal: "21" }, { city: "Lleida", province: "Lleida", postal: "25" },
    { city: "Tarragona", province: "Tarragona", postal: "43" }, { city: "León", province: "León", postal: "24" },
    { city: "Cádiz", province: "Cádiz", postal: "11" }, { city: "Jerez de la Frontera", province: "Cádiz", postal: "11" },
    { city: "Jaén", province: "Jaén", postal: "23" }, { city: "Ourense", province: "Ourense", postal: "32" },
    { city: "Girona", province: "Girona", postal: "17" }, { city: "Lugo", province: "Lugo", postal: "27" },
    { city: "Cáceres", province: "Cáceres", postal: "10" }, { city: "Guadalajara", province: "Guadalajara", postal: "19" },
    { city: "Toledo", province: "Toledo", postal: "45" }, { city: "Ciudad Real", province: "Ciudad Real", postal: "13" },
    { city: "Huesca", province: "Huesca", postal: "22" }, { city: "Teruel", province: "Teruel", postal: "44" },
    { city: "Segovia", province: "Segovia", postal: "40" }, { city: "Ávila", province: "Ávila", postal: "05" },
    { city: "Soria", province: "Soria", postal: "42" }, { city: "Zamora", province: "Zamora", postal: "49" },
    { city: "Palencia", province: "Palencia", postal: "34" }, { city: "Cuenca", province: "Cuenca", postal: "16" },
  ],
  streetTypes: ["Calle", "Calle", "Calle", "Avenida", "Plaza", "Paseo", "Camino", "Ronda", "Travesía"],
  streets: [
    "Mayor", "Real", "Nueva", "de la Constitución", "del Sol", "de la Paz", "de Cervantes", "de Goya", "de Alcalá",
    "de Velázquez", "de los Olmos", "de la Estación", "del Carmen", "San Juan", "San Francisco", "Santa María",
    "de Colón", "de Gran Vía", "del Prado", "de la Iglesia", "de Andalucía", "de Aragón", "de Castilla", "del Mar",
    "de las Flores", "de la Libertad", "Doctor Fleming", "Ramón y Cajal", "Juan de la Cierva", "Blasco Ibáñez",
    "de Lope de Vega", "de Antonio Machado", "de la Rosaleda", "del Pilar", "de Valencia", "de Toledo",
  ],
  countries: [
    { name: "España", iso2: "ES", iso3: "ESP", weight: 70 }, { name: "Portugal", iso2: "PT", iso3: "PRT", weight: 5 },
    { name: "Francia", iso2: "FR", iso3: "FRA", weight: 5 }, { name: "Italia", iso2: "IT", iso3: "ITA", weight: 4 },
    { name: "Alemania", iso2: "DE", iso3: "DEU", weight: 4 }, { name: "México", iso2: "MX", iso3: "MEX", weight: 3 },
    { name: "Argentina", iso2: "AR", iso3: "ARG", weight: 2 }, { name: "Colombia", iso2: "CO", iso3: "COL", weight: 2 },
    { name: "Reino Unido", iso2: "GB", iso3: "GBR", weight: 2 }, { name: "Chile", iso2: "CL", iso3: "CHL", weight: 1 },
    { name: "Perú", iso2: "PE", iso3: "PER", weight: 1 }, { name: "Países Bajos", iso2: "NL", iso3: "NLD", weight: 1 },
  ],
  companyWords: [
    "Construcciones", "Transportes", "Distribuciones", "Talleres", "Consultoría", "Inversiones", "Servicios",
    "Suministros", "Ingeniería", "Asesores", "Comercial", "Logística", "Alimentación", "Hostelería", "Grupo",
    "Tecnologías", "Instalaciones", "Gestoría", "Farmacia", "Panadería",
  ],
  companySuffixes: ["S.L.", "S.L.", "S.L.", "S.A.", "S.L.U.", "S.Coop.", "e Hijos S.L.", "y Asociados S.L."],
  productNouns: [
    "Silla", "Mesa", "Lámpara", "Mochila", "Cafetera", "Teclado", "Ratón", "Monitor", "Altavoz", "Auriculares",
    "Cuaderno", "Bolígrafo", "Taza", "Botella", "Chaqueta", "Camiseta", "Zapatillas", "Reloj", "Cámara", "Tostadora",
    "Batidora", "Sartén", "Cojín", "Alfombra", "Estantería", "Bicicleta", "Patinete", "Tableta", "Impresora", "Router",
  ],
  productAdjectives: [
    "ergonómica", "compacta", "inalámbrica", "plegable", "de acero", "de madera", "premium", "básica", "deportiva",
    "clásica", "moderna", "de viaje", "profesional", "ecológica", "reforzada", "ligera", "portátil", "de diseño",
  ],
  statuses: ["activo", "activo", "activo", "pendiente", "inactivo", "bloqueado"],
  domains: ["example.com", "example.org", "example.net", "correo.example", "empresa.test", "mail.test"],
};

const EN: LocaleData = {
  male: [
    "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Daniel",
    "Matthew", "Anthony", "Mark", "Steven", "Paul", "Andrew", "Joshua", "Kevin", "Brian", "George", "Edward", "Ryan",
    "Jacob", "Oliver", "Harry", "Jack", "Noah", "Leo", "Oscar", "Henry", "Samuel",
  ],
  female: [
    "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen", "Lisa",
    "Nancy", "Betty", "Emily", "Emma", "Olivia", "Amelia", "Sophia", "Isabella", "Charlotte", "Grace", "Lily", "Chloe",
    "Hannah", "Rachel", "Laura", "Megan", "Rebecca", "Alice", "Ella", "Ruby", "Lucy",
  ],
  surnames: [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas",
    "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker",
    "Young", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell",
    "Roberts", "Carter", "Phillips", "Evans", "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris", "Murphy",
    "Cook", "Rogers", "Morgan", "Cooper", "Peterson", "Reed", "Bailey", "Bell", "Kelly", "Howard", "Ward", "Cox",
  ],
  places: [
    { city: "New York", province: "NY", postal: "100" }, { city: "Buffalo", province: "NY", postal: "142" },
    { city: "Los Angeles", province: "CA", postal: "900" }, { city: "San Francisco", province: "CA", postal: "941" },
    { city: "San Diego", province: "CA", postal: "921" }, { city: "Chicago", province: "IL", postal: "606" },
    { city: "Houston", province: "TX", postal: "770" }, { city: "Austin", province: "TX", postal: "787" },
    { city: "Dallas", province: "TX", postal: "752" }, { city: "Phoenix", province: "AZ", postal: "850" },
    { city: "Philadelphia", province: "PA", postal: "191" }, { city: "Pittsburgh", province: "PA", postal: "152" },
    { city: "Seattle", province: "WA", postal: "981" }, { city: "Denver", province: "CO", postal: "802" },
    { city: "Boston", province: "MA", postal: "021" }, { city: "Miami", province: "FL", postal: "331" },
    { city: "Orlando", province: "FL", postal: "328" }, { city: "Atlanta", province: "GA", postal: "303" },
    { city: "Portland", province: "OR", postal: "972" }, { city: "Nashville", province: "TN", postal: "372" },
    { city: "Detroit", province: "MI", postal: "482" }, { city: "Minneapolis", province: "MN", postal: "554" },
    { city: "Las Vegas", province: "NV", postal: "891" }, { city: "Salt Lake City", province: "UT", postal: "841" },
    { city: "Kansas City", province: "MO", postal: "641" }, { city: "Columbus", province: "OH", postal: "432" },
    { city: "Charlotte", province: "NC", postal: "282" }, { city: "Baltimore", province: "MD", postal: "212" },
  ],
  streetTypes: ["Street", "Street", "Avenue", "Road", "Lane", "Drive", "Boulevard", "Court", "Place"],
  streets: [
    "Main", "Oak", "Maple", "Cedar", "Pine", "Elm", "Washington", "Lake", "Hill", "Park", "Sunset", "Lincoln",
    "Jefferson", "Highland", "Church", "River", "Spring", "Center", "Mill", "Forest", "Madison", "Franklin",
  ],
  countries: [
    { name: "United States", iso2: "US", iso3: "USA", weight: 60 }, { name: "Canada", iso2: "CA", iso3: "CAN", weight: 8 },
    { name: "United Kingdom", iso2: "GB", iso3: "GBR", weight: 8 }, { name: "Ireland", iso2: "IE", iso3: "IRL", weight: 3 },
    { name: "Australia", iso2: "AU", iso3: "AUS", weight: 5 }, { name: "New Zealand", iso2: "NZ", iso3: "NZL", weight: 2 },
    { name: "Germany", iso2: "DE", iso3: "DEU", weight: 4 }, { name: "France", iso2: "FR", iso3: "FRA", weight: 4 },
    { name: "Spain", iso2: "ES", iso3: "ESP", weight: 3 }, { name: "Mexico", iso2: "MX", iso3: "MEX", weight: 3 },
  ],
  companyWords: [
    "Global", "United", "Pacific", "Atlantic", "Summit", "Pioneer", "Liberty", "Northern", "Golden", "Silver",
    "Apex", "Vertex", "Blue River", "Evergreen", "Redwood", "Granite", "Harbor", "Prairie", "Keystone", "Sterling",
  ],
  companySuffixes: ["Inc.", "Inc.", "LLC", "Ltd", "Group", "Corp.", "& Co.", "Holdings"],
  productNouns: [
    "Chair", "Desk", "Lamp", "Backpack", "Coffee Maker", "Keyboard", "Mouse", "Monitor", "Speaker", "Headphones",
    "Notebook", "Pen", "Mug", "Bottle", "Jacket", "T-Shirt", "Sneakers", "Watch", "Camera", "Toaster", "Blender",
    "Pan", "Cushion", "Rug", "Bookshelf", "Bicycle", "Scooter", "Tablet", "Printer", "Router",
  ],
  productAdjectives: [
    "Ergonomic", "Compact", "Wireless", "Foldable", "Steel", "Wooden", "Premium", "Basic", "Sport", "Classic",
    "Modern", "Travel", "Pro", "Eco", "Heavy-Duty", "Lightweight", "Portable", "Designer",
  ],
  statuses: ["active", "active", "active", "pending", "inactive", "suspended"],
  domains: ["example.com", "example.org", "example.net", "mail.example", "company.test", "inbox.test"],
};

export const LOCALES: Record<Locale, LocaleData> = { es: ES, en: EN };

/** Words for descriptions and filler text (lorem ipsum: the same in every locale). */
export const LOREM = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna " +
  "aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute " +
  "irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non " +
  "proident sunt culpa qui officia deserunt mollit anim id est laborum"
).split(" ");
