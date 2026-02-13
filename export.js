import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";
import * as turf from "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/+esm";

class ExportApp {
    constructor() {
        this.db = null;
        this.loadedFiles = new Set();
        this.map = null;
        this.mapPolygons = [];
        this.mapInfoWindows = [];
        this.features = []; // Store all features with their properties
        this.customProperties = []; // Store custom property names from CSV
        this.plotIdCounter = 0; // Counter for generating unique plot IDs
        this.usedKeys = new Set(); // Track all used property keys
        this.usedValues = new Set(); // Track all used property values
        this.rowsWithMissingGeojson = []; // Track rows that had no geojson found
        this.init();
    }

    async init() {
        try {
            console.log('Initializing Export App...');
            
            // Show loading
            $('#loading').show();
            
            // Initialize DuckDB
            const bundles = duckdb.getJsDelivrBundles();
            const bundle = await duckdb.selectBundle(bundles);
            const worker = await duckdb.createWorker(bundle.mainWorker);
            const logger = new duckdb.ConsoleLogger();
            this.db = new duckdb.AsyncDuckDB(logger, worker);
            await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
            
            console.log('DuckDB initialized successfully');

            // Try to load spatial extension
            try {
                const connection = await this.db.connect();
                try {
                    await connection.query("INSTALL spatial;");
                    await connection.query("LOAD spatial;");
                    console.log('Spatial extension loaded');
                    this.spatialEnabled = true;
                } catch (spatialError) {
                    console.warn('Spatial extension not available:', spatialError.message);
                    this.spatialEnabled = false;
                } finally {
                    await connection.close();
                }
            } catch (error) {
                console.warn('Could not test spatial extension:', error.message);
                this.spatialEnabled = false;
            }

            // Initialize map
            this.initializeMap();

            // Load dropdown data
            await this.loadDropdownData();
            
            // Setup event listeners
            this.setupEventListeners();
            
            $('#loading').hide();
        } catch (error) {
            console.error('Failed to initialize app:', error);
            alert('Failed to initialize application: ' + error.message);
            $('#loading').hide();
        }
    }

    initializeMap() {
        try {
            this.map = new google.maps.Map(document.getElementById('map'), {
                center: { lat: 15.2993, lng: 74.124 }, // Goa coordinates
                zoom: 10,
                mapTypeId: 'satellite',
                mapTypeControl: true,
                mapTypeControlOptions: {
                    style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
                    position: google.maps.ControlPosition.TOP_RIGHT
                },
                zoomControl: true,
                streetViewControl: false,
                fullscreenControl: true
            });

            console.log('Google Maps initialized successfully');
        } catch (error) {
            console.error('Failed to initialize map:', error);
        }
    }

    async loadDropdownData() {
        try {
            // Load taluka data
            await this.populateTalukaDropdown();
        } catch (error) {
            console.error('Error loading dropdown data:', error);
        }
    }

    async populateTalukaDropdown() {
        try {
            const tableName = 'talukas_metadata';
            if (!this.loadedFiles.has(tableName)) {
                await this.loadParquetFile('talukas.parquet', tableName);
            }

            const connection = await this.db.connect();
            try {
                const result = await connection.query(`SELECT DISTINCT taluka FROM ${tableName} ORDER BY taluka`);
                const talukas = result.toArray();

                const dropdown = $('#taluka-dropdown');
                dropdown.empty().append('<option value="">Select Taluka</option>');
                
                talukas.forEach(row => {
                    dropdown.append(`<option value="${row.taluka}">${row.taluka}</option>`);
                });
                
                dropdown.prop('disabled', false);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating taluka dropdown:', error);
        }
    }

    async populateVillageDropdown(taluka) {
        try {
            const tableName = 'taluka_village_mapping';
            if (!this.loadedFiles.has(tableName)) {
                await this.loadParquetFile('taluka_village_mapping.parquet', tableName);
            }

            const connection = await this.db.connect();
            try {
                const escapedTaluka = taluka.replace(/'/g, "''");
                const result = await connection.query(`
                    SELECT DISTINCT village 
                    FROM ${tableName} 
                    WHERE taluka = '${escapedTaluka}' 
                    ORDER BY village
                `);
                const villages = result.toArray();

                const dropdown = $('#village-dropdown');
                dropdown.empty().append('<option value="">Select Village</option>');
                
                villages.forEach(row => {
                    dropdown.append(`<option value="${row.village}">${row.village}</option>`);
                });
                
                dropdown.prop('disabled', false);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating village dropdown:', error);
        }
    }

    async populateSurveyDropdown(village) {
        try {
            const safeVillageName = village.replace(/[^a-zA-Z0-9-_]/g, '_');
            const tableName = `village_${safeVillageName}`;
            
            if (!this.loadedFiles.has(tableName)) {
                await this.loadParquetFile(`${village}.parquet`, tableName);
            }

            const connection = await this.db.connect();
            try {
                const result = await connection.query(`
                    SELECT DISTINCT survey 
                    FROM ${tableName} 
                    WHERE survey IS NOT NULL 
                    ORDER BY survey
                `);
                const surveys = result.toArray();

                const dropdown = $('#survey-dropdown');
                dropdown.empty().append('<option value="">All Surveys</option>');
                
                surveys.forEach(row => {
                    if (row.survey) {
                        dropdown.append(`<option value="${row.survey}">${row.survey}</option>`);
                    }
                });
                
                dropdown.prop('disabled', false);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating survey dropdown:', error);
        }
    }

    async populateSubdivDropdown(village, survey) {
        try {
            const safeVillageName = village.replace(/[^a-zA-Z0-9-_]/g, '_');
            const tableName = `village_${safeVillageName}`;

            const connection = await this.db.connect();
            try {
                let query = `SELECT DISTINCT subdiv FROM ${tableName} WHERE subdiv IS NOT NULL`;
                if (survey) {
                    const escapedSurvey = survey.replace(/'/g, "''");
                    query += ` AND survey = '${escapedSurvey}'`;
                }
                query += ` ORDER BY subdiv`;

                const result = await connection.query(query);
                const subdivs = result.toArray();

                const dropdown = $('#subdiv-dropdown');
                dropdown.empty().append('<option value="">All Subdivs</option>');
                
                subdivs.forEach(row => {
                    if (row.subdiv) {
                        dropdown.append(`<option value="${row.subdiv}">${row.subdiv}</option>`);
                    }
                });
                
                dropdown.prop('disabled', false);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error('Error populating subdiv dropdown:', error);
        }
    }

    setupEventListeners() {
        // CSV upload listeners
        $('#csv-upload').on('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                $('#process-csv').prop('disabled', false);
                $('#csv-status').text(`Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
            } else {
                $('#process-csv').prop('disabled', true);
                $('#csv-status').text('');
            }
        });

        $('#process-csv').on('click', () => {
            this.processCsvFile();
        });

        $('#download-template').on('click', () => {
            this.downloadCsvTemplate();
        });

        // Dropdown listeners
        $('#taluka-dropdown').on('change', async (e) => {
            const taluka = e.target.value;
            if (taluka) {
                await this.populateVillageDropdown(taluka);
                $('#survey-dropdown').prop('disabled', true).empty().append('<option value="">Select Village First</option>');
                $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey First</option>');
                $('#add-plot-button').prop('disabled', true);
            } else {
                $('#village-dropdown').prop('disabled', true).empty().append('<option value="">Select Village</option>');
                $('#survey-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey No (Optional)</option>');
                $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Subdiv (Optional)</option>');
                $('#add-plot-button').prop('disabled', true);
            }
        });

        $('#village-dropdown').on('change', async (e) => {
            const village = e.target.value;
            if (village) {
                await this.populateSurveyDropdown(village);
                $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey First</option>');
                $('#add-plot-button').prop('disabled', false);
            } else {
                $('#survey-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey No (Optional)</option>');
                $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Subdiv (Optional)</option>');
                $('#add-plot-button').prop('disabled', true);
            }
        });

        $('#survey-dropdown').on('change', async (e) => {
            const survey = e.target.value;
            const village = $('#village-dropdown').val();
            if (village) {
                await this.populateSubdivDropdown(village, survey);
            }
        });

        // Add plot button
        $('#add-plot-button').on('click', () => {
            this.addPlotFromDropdowns();
        });
    }

    async addPlotFromDropdowns() {
        const taluka = $('#taluka-dropdown').val();
        const village = $('#village-dropdown').val();
        let survey = $('#survey-dropdown').val();
        let subdiv = $('#subdiv-dropdown').val();

        if (!village) {
            alert('Please select at least a Village');
            return;
        }

        // Convert empty strings to null explicitly
        if (!survey || survey.trim() === '') {
            survey = null;
        }
        if (!subdiv || subdiv.trim() === '') {
            subdiv = null;
        }

        console.log('Adding plot with:', { taluka, village, survey, subdiv });

        $('#loading').show();

        try {
            const rowData = {
                taluka: taluka || null,
                village: village,
                survey: survey,
                subdiv: subdiv, // null means "fetch all subdivs for this survey"
                customProperties: {} // No custom properties from dropdowns initially
            };

            const results = await this.searchSingleRow(rowData);
            
            if (results.length === 0) {
                // Create a placeholder feature with missing geojson flag
                // Note: subdiv already defaulted to "0" above if survey exists
                const missingFeature = {
                    type: 'Feature',
                    geometry: null,
                    properties: {
                        taluka: rowData.taluka || 'Unknown',
                        village: rowData.village,
                        survey: rowData.survey || '-',
                        subdiv: rowData.subdiv || '-',
                        _plotId: `plot_${this.plotIdCounter++}`,
                        _missingGeojson: true
                    }
                };
                this.features.push(missingFeature);
                this.rowsWithMissingGeojson.push(missingFeature);
                $('#csv-status').html('<span style="color: #ff9800;">⚠️ No geojson found - row added for manual entry</span>');
            } else {
                // Add unique IDs to features
                results.forEach(result => {
                    result.properties._plotId = `plot_${this.plotIdCounter++}`;
                    this.features.push(result);
                });
                $('#csv-status').html(`<span style="color: #28a745;">✓ Added ${results.length} plot(s)</span>`);
            }
            
            // Update display
            this.displayResults();
            
            // Try to display on map, but don't fail if there are issues
            try {
                this.displayOnMap();
            } catch (mapError) {
                console.warn('Error displaying on map:', mapError);
                // Continue anyway - the table is still useful
            }
            
            // Show results section and enable export
            $('#results-section').show();
            $('#export-button').prop('disabled', false);
            $('#plot-count').text(this.features.length);

        } catch (error) {
            console.error('Error adding plot:', error);
            alert('Error adding plot: ' + error.message);
        } finally {
            $('#loading').hide();
        }
    }

    downloadCsvTemplate() {
        const csvContent = 'village,survey,subdiv,taluka\n' +
                         'Panaji,123,A,TISWADI\n' +
                         'Margao,99/5-A,,\n' +
                         'Vasco,456,,\n' +
                         'Ponda,24,,';
        
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export_template.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async processCsvFile() {
        const fileInput = document.getElementById('csv-upload');
        const file = fileInput.files[0];
        
        if (!file) {
            alert('Please select a CSV file first');
            return;
        }

        $('#csv-status').text('Processing CSV...');
        $('#process-csv').prop('disabled', true);
        $('#loading').show();

        try {
            const csvText = await this.readFileAsText(file);
            const parsedData = this.parseCsv(csvText);
            
            if (parsedData.rows.length === 0) {
                $('#csv-status').html('<span style="color: #dc3545;">No valid data found in CSV</span>');
                $('#process-csv').prop('disabled', false);
                $('#loading').hide();
                return;
            }

            // Store custom properties for later use
            this.customProperties = parsedData.customProperties;
            
            $('#csv-status').text(`Found ${parsedData.rows.length} rows. Searching...`);
            
            await this.searchAndDisplay(parsedData.rows);
            
        } catch (error) {
            console.error('Error processing CSV:', error);
            $('#csv-status').html(`<span style="color: #dc3545;">Error: ${error.message}</span>`);
            alert('Error: ' + error.message);
        } finally {
            $('#process-csv').prop('disabled', false);
            $('#loading').hide();
        }
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    parseCsv(csvText) {
        const lines = csvText.trim().split('\n');
        if (lines.length < 2) {
            throw new Error('CSV must have at least a header row and one data row');
        }

        // Parse headers
        const headers = lines[0].split(',').map(h => h.trim());
        const lowerHeaders = headers.map(h => h.toLowerCase());
        
        // Find required columns (case-insensitive)
        const talukaIndex = lowerHeaders.indexOf('taluka');
        const villageIndex = lowerHeaders.indexOf('village');
        const surveyIndex = lowerHeaders.indexOf('survey');
        const subdivIndex = lowerHeaders.indexOf('subdiv');

        // Village is required, taluka is now optional (will be auto-detected)
        if (villageIndex === -1) {
            throw new Error('CSV must have a "village" column');
        }

        // Identify custom property columns (all columns except the standard ones)
        const standardIndices = [talukaIndex, villageIndex, surveyIndex, subdivIndex].filter(i => i !== -1);
        const customPropertyIndices = headers.map((h, i) => i).filter(i => !standardIndices.includes(i));
        const customProperties = customPropertyIndices.map(i => headers[i]);

        console.log('📊 CSV Columns detected:', {
            taluka: talukaIndex !== -1 ? `✅ column ${talukaIndex}` : '❌ not found',
            village: villageIndex !== -1 ? `✅ column ${villageIndex}` : '❌ not found',
            survey: surveyIndex !== -1 ? `✅ column ${surveyIndex}` : '❌ not found',
            subdiv: subdivIndex !== -1 ? `✅ column ${subdivIndex}` : '❌ not found',
            customProperties: customProperties.length > 0 ? customProperties : 'none'
        });

        // Parse data rows
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue; // Skip empty lines
            
            const values = this.parseCsvLine(line);
            
            // Only require village to be present
            if (values.length >= headers.length && values[villageIndex]) {
                let survey = surveyIndex !== -1 ? values[surveyIndex] : null;
                let subdiv = subdivIndex !== -1 ? values[subdivIndex] : null;
                let originalSurvey = survey; // Preserve original before any processing
                
                // Smart detection of combined survey/subdiv format
                // Examples: "24/0", "99/5-A", "123/4B", etc.
                // Only split if:
                // 1. Survey value contains '/'
                // 2. There's no explicit subdiv value OR subdiv column doesn't exist
                if (survey && survey.includes('/')) {
                    const hasExplicitSubdiv = subdivIndex !== -1 && subdiv && subdiv.trim() !== '';
                    
                    if (!hasExplicitSubdiv) {
                        // Split the combined format
                        const parts = survey.split('/');
                        survey = parts[0].trim();
                        subdiv = parts.length > 1 ? parts[1].trim() : '';
                        console.log(`📋 CSV: Detected combined survey/subdiv format "${originalSurvey}" → survey="${survey}", subdiv="${subdiv}"`);
                    } else {
                        console.log(`📋 CSV: Found explicit subdiv column, keeping survey="${survey}" as-is`);
                    }
                }
                
                // Normalize empty strings to null for consistent handling
                if (survey !== null && survey.trim() === '') {
                    survey = null;
                }
                if (subdiv !== null && subdiv.trim() === '') {
                    subdiv = null;
                }
                
                const rowData = {
                    taluka: talukaIndex !== -1 ? values[talukaIndex] : null, // Can be null, will be auto-detected
                    village: values[villageIndex],
                    survey: survey,
                    subdiv: subdiv, // null means "fetch all subdivs for this survey"
                    _originalSurvey: originalSurvey, // Keep original value for fallback search
                    customProperties: {},
                    _csvRowIndex: i // Track original row number for error reporting
                };

                // Capture custom properties
                customPropertyIndices.forEach(index => {
                    const propName = headers[index];
                    rowData.customProperties[propName] = values[index] || '';
                });

                rows.push(rowData);
            }
        }

        return { rows, customProperties };
    }

    // Helper to parse CSV line handling quoted values
    parseCsvLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim());
        
        return values;
    }

    async searchAndDisplay(rows) {
        this.features = []; // Reset features
        this.rowsWithMissingGeojson = []; // Reset missing rows tracker
        
        let totalCsvRows = rows.length;
        let totalPlotsFound = 0;
        
        console.log(`🚀 Starting search for ${totalCsvRows} CSV rows...`);
        
        for (const row of rows) {
            console.log(`\n📍 CSV Row ${row._csvRowIndex}: Searching for ${row.village}`, {
                taluka: row.taluka || 'auto-detect',
                survey: row.survey || 'all',
                subdiv: row.subdiv || 'all',
                originalSurvey: row._originalSurvey
            });
            try {
                const results = await this.searchSingleRow(row);
                if (results.length > 0) {
                    // Add features with their custom properties
                    results.forEach(result => {
                        this.features.push(result);
                    });
                    totalPlotsFound += results.length;
                    console.log(`✅ CSV Row ${row._csvRowIndex}: Found ${results.length} plot(s) for ${row.village} survey ${row.survey || 'all'} subdiv ${row.subdiv || 'all'}`);
                } else {
                    // No geojson found for this row - create a placeholder feature
                    const missingFeature = {
                        type: 'Feature',
                        geometry: null,
                        properties: {
                            taluka: row.taluka || 'Unknown',
                            village: row.village,
                            survey: row.survey || '-',
                            subdiv: row.subdiv || 'All',
                            _plotId: `plot_${this.plotIdCounter++}`,
                            _missingGeojson: true, // Flag to indicate missing data
                            _csvRowIndex: row._csvRowIndex,
                            ...row.customProperties
                        }
                    };
                    this.features.push(missingFeature);
                    this.rowsWithMissingGeojson.push(missingFeature);
                    console.warn(`⚠️ CSV Row ${row._csvRowIndex}: No plots found for ${row.village} survey ${row.survey || 'all'} subdiv ${row.subdiv || 'all'}`);
                }
            } catch (error) {
                console.error(`❌ CSV Row ${row._csvRowIndex}: Error searching for ${row.taluka || 'unknown'}/${row.village}:`, error);
                console.error(`❌ CSV Row ${row._csvRowIndex} data:`, JSON.stringify({
                    taluka: row.taluka,
                    village: row.village,
                    survey: row.survey,
                    subdiv: row.subdiv,
                    originalSurvey: row._originalSurvey
                }));
                // Create a placeholder feature for errors too
                const errorFeature = {
                    type: 'Feature',
                    geometry: null,
                    properties: {
                        taluka: row.taluka || 'Unknown',
                        village: row.village,
                        survey: row.survey || '-',
                        subdiv: row.subdiv || 'All',
                        _plotId: `plot_${this.plotIdCounter++}`,
                        _missingGeojson: true,
                        _error: error.message,
                        _csvRowIndex: row._csvRowIndex,
                        ...row.customProperties
                    }
                };
                this.features.push(errorFeature);
                this.rowsWithMissingGeojson.push(errorFeature);
            }
        }

        console.log(`\n🎯 Search Summary:
- Total CSV rows: ${totalCsvRows}
- Plots found: ${totalPlotsFound}
- Rows with missing geojson: ${this.rowsWithMissingGeojson.length}
- Total features: ${this.features.length}`);

        if (this.features.length === 0) {
            console.error('❌ No data to display - all searches returned 0 results');
            $('#csv-status').html('<span style="color: #dc3545;">No data to display</span>');
            alert('No data to display. Please check your CSV data.');
            return;
        }

        const foundCount = this.features.length - this.rowsWithMissingGeojson.length;
        const missingCount = this.rowsWithMissingGeojson.length;
        
        let statusMessage = `<span style="color: #28a745;">✓ Found ${foundCount} plot(s) from ${totalCsvRows} CSV row(s)</span>`;
        if (missingCount > 0) {
            statusMessage += ` <span style="color: #ff9800;">⚠️ ${missingCount} row(s) with no geojson found</span>`;
        }
        $('#csv-status').html(statusMessage);
        
        // Display results
        this.displayResults();
        
        // Try to display on map, but don't fail if there are issues
        try {
            this.displayOnMap();
        } catch (mapError) {
            console.warn('Error displaying on map:', mapError);
            // Continue anyway - the table is still useful
        }
        
        // Show results section and enable export
        $('#results-section').show();
        $('#export-button').prop('disabled', false);
        $('#plot-count').text(this.features.length);
    }

    async searchSingleRow(row) {
        // Normalize village name for file loading
        const safeVillageName = row.village.replace(/[^a-zA-Z0-9-_]/g, '_');
        const tableName = `village_${safeVillageName}`;
        
        // Load village file if not already loaded
        if (!this.loadedFiles.has(tableName)) {
            await this.loadParquetFile(`${row.village}.parquet`, tableName);
        }

        const connection = await this.db.connect();
        
        try {
            // Auto-detect taluka if not provided
            if (!row.taluka) {
                try {
                    const talukaResult = await connection.query(`SELECT DISTINCT taluka FROM ${tableName} LIMIT 1`);
                    const talukaData = talukaResult.toArray();
                    if (talukaData.length > 0 && talukaData[0].taluka) {
                        row.taluka = talukaData[0].taluka;
                        console.log(`Auto-detected taluka for ${row.village}: ${row.taluka}`);
                    }
                } catch (error) {
                    console.warn(`Could not auto-detect taluka for ${row.village}:`, error);
                }
            }
            
            // Store original survey value for potential combined format search
            const originalSurvey = row._originalSurvey || row.survey;
            
            let whereClause = '';
            let filters = [];
            
            // Case-insensitive taluka matching
            if (row.taluka) {
                const escapedTaluka = row.taluka.replace(/'/g, "''");
                filters.push(`LOWER(taluka) = LOWER('${escapedTaluka}')`);
            }
            
            if (row.survey) {
                const escapedSurvey = row.survey.replace(/'/g, "''");
                filters.push(`survey = '${escapedSurvey}'`);
            }
            
            // Only filter by subdiv if it's explicitly provided
            // If subdiv is null/empty, we fetch ALL subdivs for the survey
            if (row.subdiv !== null && row.subdiv !== undefined && row.subdiv !== '') {
                const escapedSubdiv = row.subdiv.replace(/'/g, "''");
                filters.push(`subdiv = '${escapedSubdiv}'`);
                console.log('Added subdiv filter:', `subdiv = '${escapedSubdiv}'`);
            } else {
                console.log('No subdiv filter - fetching all subdivs');
            }
            
            if (filters.length > 0) {
                whereClause = 'WHERE ' + filters.join(' AND ');
            }

            console.log('SQL Query WHERE clause:', whereClause);

            let result;
            let sqlQuery = '';
            if (this.spatialEnabled) {
                try {
                    sqlQuery = `SELECT taluka, village, survey, subdiv, ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson FROM ${tableName} ${whereClause} LIMIT 100`;
                    console.log('🔍 Executing SQL:', sqlQuery);
                    result = await connection.query(sqlQuery);
                } catch (spatialError) {
                    console.error('❌ Spatial query failed:', spatialError);
                    console.error('❌ Failed SQL:', sqlQuery);
                    return [];
                }
            } else {
                console.warn('Spatial extension not available');
                return [];
            }

            const data = result.toArray();
            console.log(`✅ Query returned ${data.length} rows from database`);
            
            // If no results and we had split a combined survey/subdiv format, try searching with combined format
            if (data.length === 0 && originalSurvey && originalSurvey.includes('/') && row.survey !== originalSurvey) {
                console.log(`⚠️ No results with split format. Trying combined format: ${originalSurvey}`);
                
                let combinedFilters = [];
                if (row.taluka) {
                    const escapedTaluka = row.taluka.replace(/'/g, "''");
                    combinedFilters.push(`LOWER(taluka) = LOWER('${escapedTaluka}')`);
                }
                const escapedOriginalSurvey = originalSurvey.replace(/'/g, "''");
                combinedFilters.push(`survey = '${escapedOriginalSurvey}'`);
                
                const combinedWhereClause = combinedFilters.length > 0 ? 'WHERE ' + combinedFilters.join(' AND ') : '';
                const combinedSqlQuery = `SELECT taluka, village, survey, subdiv, ST_AsGeoJSON(ST_GeomFromWKB(geometry)) as geometry_geojson FROM ${tableName} ${combinedWhereClause} LIMIT 100`;
                
                try {
                    console.log('🔍 Executing fallback SQL:', combinedSqlQuery);
                    result = await connection.query(combinedSqlQuery);
                    const combinedData = result.toArray();
                    console.log(`✅ Combined format query returned ${combinedData.length} rows`);
                    if (combinedData.length > 0) {
                        return this.processQueryResults(combinedData, row);
                    }
                } catch (error) {
                    console.error('❌ Combined format query failed:', error);
                    console.error('❌ Failed SQL:', combinedSqlQuery);
                }
            }
            
            // Log if no matching records found
            if (data.length === 0) {
                console.error(`❌ No matching records found for: ${JSON.stringify({
                    taluka: row.taluka,
                    village: row.village, 
                    survey: row.survey,
                    subdiv: row.subdiv,
                    originalSurvey: originalSurvey
                })}`);
                console.error('❌ SQL that returned 0 results:', sqlQuery);
            }
            
            return this.processQueryResults(data, row);

        } finally {
            await connection.close();
        }
    }
    
    processQueryResults(data, row) {
        const features = [];
        console.log(`📦 Processing ${data.length} database rows`);
        data.forEach((dbRow, index) => {
            console.log(`  Row ${index + 1}:`, { 
                taluka: dbRow.taluka,
                village: dbRow.village,
                survey: dbRow.survey, 
                subdiv: dbRow.subdiv,
                hasGeometry: !!dbRow.geometry_geojson
            });
            if (dbRow.geometry_geojson) {
                try {
                    const geometryString = typeof dbRow.geometry_geojson === 'string' 
                        ? dbRow.geometry_geojson 
                        : JSON.stringify(dbRow.geometry_geojson);
                    
                    const geojsonGeometry = JSON.parse(geometryString);
                    
                    if (geojsonGeometry && geojsonGeometry.type) {
                        // Combine standard properties with custom properties
                        const properties = {
                            taluka: String(dbRow.taluka || ''),
                            village: String(dbRow.village || ''),
                            survey: String(dbRow.survey || ''),
                            subdiv: String(dbRow.subdiv || ''),
                            _plotId: `plot_${this.plotIdCounter++}`, // Add unique ID
                            ...row.customProperties // Add custom properties from CSV
                        };
                        
                        features.push({
                            type: 'Feature',
                            geometry: geojsonGeometry,
                            properties: properties
                        });
                    }
                    } catch (parseError) {
                        console.error('❌ Could not parse geometry for row:', parseError);
                    }
                } else {
                    console.warn('⚠️ No geometry_geojson found in database row');
                }
            });

        console.log(`✅ Returning ${features.length} features with valid geojson`);
        return features;
    }

    async loadParquetFile(filename, tableName) {
        try {
            console.log(`Loading ${filename}...`);
            const response = await fetch(`data/${filename}`);
            
            if (!response.ok) {
                throw new Error(`File not found: ${filename}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            const connection = await this.db.connect();
            try {
                await this.db.registerFileBuffer(filename, uint8Array);
                await connection.query(`CREATE TABLE IF NOT EXISTS ${tableName} AS SELECT * FROM parquet_scan('${filename}')`);
                this.loadedFiles.add(tableName);
                console.log(`Loaded ${filename} into ${tableName}`);
            } finally {
                await connection.close();
            }
        } catch (error) {
            console.error(`Error loading ${filename}:`, error);
            throw new Error(`Could not load data for village: ${filename}`);
        }
    }

    collectUsedKeysAndValues() {
        // Collect all unique keys and values from all features
        this.usedKeys.clear();
        this.usedValues.clear();
        
        const standardProps = ['taluka', 'village', 'survey', 'subdiv', '_plotId'];
        
        this.features.forEach(feature => {
            Object.keys(feature.properties).forEach(key => {
                if (!standardProps.includes(key)) {
                    this.usedKeys.add(key);
                    const value = feature.properties[key];
                    if (value) {
                        this.usedValues.add(String(value));
                    }
                }
            });
        });
    }

    displayResults() {
        // Update the sets of used keys and values
        this.collectUsedKeysAndValues();
        
        const tbody = $('#results-table-body');
        tbody.empty();

        // Create/update datalists for autocomplete
        this.updateDataLists();

        this.features.forEach((feature, index) => {
            const props = feature.properties;
            const plotId = props._plotId;
            const hasMissingGeojson = props._missingGeojson === true;
            
            // Get custom properties (exclude standard ones and internal flags)
            const standardProps = ['taluka', 'village', 'survey', 'subdiv', '_plotId', '_missingGeojson', '_error', '_csvRowIndex'];
            const customProps = Object.keys(props).filter(key => !standardProps.includes(key));
            
            // Build property list HTML
            let propertyHtml = '<div class="property-list" id="property-list-' + plotId + '">';
            customProps.forEach(key => {
                const escapedKey = key.replace(/'/g, "\\'");
                const escapedValue = (props[key] || '').replace(/'/g, "\\'");
                propertyHtml += `
                    <div class="property-item">
                        <input type="text" 
                               list="keys-datalist" 
                               value="${key}" 
                               placeholder="Key" 
                               onchange="window.exportApp.updatePropertyKey('${plotId}', '${escapedKey}', this.value)" 
                               style="width: 100px;">
                        <input type="text" 
                               list="values-datalist" 
                               value="${props[key] || ''}" 
                               placeholder="Value" 
                               onchange="window.exportApp.updatePropertyValue('${plotId}', '${escapedKey}', this.value)" 
                               style="width: 120px;">
                        <button onclick="window.exportApp.removeProperty('${plotId}', '${escapedKey}')">×</button>
                    </div>
                `;
            });
            propertyHtml += `<button class="add-property-btn" onclick="window.exportApp.addProperty('${plotId}')">+ Add Property</button>`;
            propertyHtml += '</div>';
            
            // Build warning indicator for missing geojson
            let warningHtml = '';
            if (hasMissingGeojson) {
                warningHtml = `<div class="warning-indicator" title="No geojson data found for this plot">⚠️ No map data found</div>`;
            }
            
            const rowClass = hasMissingGeojson ? 'missing-geojson' : '';
            const row = `
                <tr data-plot-id="${plotId}" class="${rowClass}">
                    <td>${props.taluka}${hasMissingGeojson ? '<br>' + warningHtml : ''}</td>
                    <td>${props.village}</td>
                    <td>${props.survey || '-'}</td>
                    <td>${props.subdiv || '-'}</td>
                    <td>${propertyHtml}</td>
                    <td>
                        <button class="remove-plot-btn" onclick="window.exportApp.removePlot('${plotId}')">
                            Remove
                        </button>
                    </td>
                </tr>
            `;
            tbody.append(row);
        });

        $('#results-table-container').show();
    }

    updateDataLists() {
        // Remove existing datalists
        $('#keys-datalist').remove();
        $('#values-datalist').remove();
        
        // Create keys datalist
        let keysDatalist = '<datalist id="keys-datalist">';
        this.usedKeys.forEach(key => {
            keysDatalist += `<option value="${key}">`;
        });
        keysDatalist += '</datalist>';
        
        // Create values datalist
        let valuesDatalist = '<datalist id="values-datalist">';
        this.usedValues.forEach(value => {
            valuesDatalist += `<option value="${value}">`;
        });
        valuesDatalist += '</datalist>';
        
        // Append to body
        $('body').append(keysDatalist);
        $('body').append(valuesDatalist);
    }

    addProperty(plotId) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;

        // Add a new empty property
        const newKey = 'new_property';
        let counter = 1;
        let finalKey = newKey;
        while (feature.properties.hasOwnProperty(finalKey)) {
            finalKey = `${newKey}_${counter}`;
            counter++;
        }
        
        feature.properties[finalKey] = '';
        
        // Add to used keys
        this.usedKeys.add(finalKey);
        
        // Refresh the display
        this.displayResults();
        try {
            this.displayOnMap(); // Update map tooltips
        } catch (mapError) {
            console.warn('Error updating map:', mapError);
        }
    }

    removeProperty(plotId, key) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;

        delete feature.properties[key];
        
        // Refresh the display
        this.displayResults();
        try {
            this.displayOnMap(); // Update map tooltips
        } catch (mapError) {
            console.warn('Error updating map:', mapError);
        }
    }

    updatePropertyKey(plotId, oldKey, newKey) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;

        if (newKey && newKey !== oldKey && !['taluka', 'village', 'survey', 'subdiv', '_plotId'].includes(newKey)) {
            const value = feature.properties[oldKey];
            delete feature.properties[oldKey];
            feature.properties[newKey] = value;
            
            // Add new key to the set
            this.usedKeys.add(newKey);
            
            // Refresh the display
            this.displayResults();
            try {
                this.displayOnMap(); // Update map tooltips
            } catch (mapError) {
                console.warn('Error updating map:', mapError);
            }
        }
    }

    updatePropertyValue(plotId, key, value) {
        const feature = this.features.find(f => f.properties._plotId === plotId);
        if (!feature) return;

        feature.properties[key] = value;
        
        // Add value to the set
        if (value) {
            this.usedValues.add(String(value));
            this.updateDataLists(); // Update the datalists
        }
        
        // Update map tooltips
        try {
            this.displayOnMap();
        } catch (mapError) {
            console.warn('Error updating map:', mapError);
        }
    }

    removePlot(plotId) {
        // Remove from features array
        const index = this.features.findIndex(f => f.properties._plotId === plotId);
        if (index > -1) {
            this.features.splice(index, 1);
        }

        // Update display
        if (this.features.length === 0) {
            $('#results-section').hide();
            $('#export-button').prop('disabled', true);
            $('#results-table-container').hide();
        } else {
            this.displayResults();
            try {
                this.displayOnMap();
            } catch (mapError) {
                console.warn('Error updating map:', mapError);
            }
            $('#plot-count').text(this.features.length);
        }
    }

    displayOnMap() {
        // Clear existing polygons
        this.mapPolygons.forEach(polygon => polygon.setMap(null));
        this.mapPolygons = [];
        this.mapInfoWindows = [];

        const bounds = new google.maps.LatLngBounds();
        let hasValidPolygons = false;

        this.features.forEach((feature, index) => {
            try {
                const geometry = feature.geometry;
                
                // Skip features with no geometry (missing geojson data)
                if (!geometry || geometry === null) {
                    return;
                }
                
                let paths = [];

                if (geometry.type === 'Polygon') {
                    paths = geometry.coordinates[0].map(coord => ({
                        lat: coord[1],
                        lng: coord[0]
                    }));
                } else if (geometry.type === 'MultiPolygon') {
                    paths = geometry.coordinates[0][0].map(coord => ({
                        lat: coord[1],
                        lng: coord[0]
                    }));
                } else {
                    return;
                }

                // Create polygon
                const polygon = new google.maps.Polygon({
                    paths: paths,
                    strokeColor: '#007cba',
                    strokeOpacity: 1.0,
                    strokeWeight: 2,
                    fillColor: '#007cba',
                    fillOpacity: 0.3,
                    map: this.map
                });

                // Create info window content with all properties (excluding _plotId and internal flags)
                let infoContent = '<div style="font-size: 12px; max-width: 300px;">';
                infoContent += '<strong>Plot Information</strong><br><br>';
                
                // Display all properties except internal ones
                const internalProps = ['_plotId', '_missingGeojson', '_error', '_csvRowIndex'];
                Object.keys(feature.properties).forEach(key => {
                    if (!internalProps.includes(key)) {
                        const value = feature.properties[key];
                        if (value) {
                            infoContent += `<strong>${key}:</strong> ${value}<br>`;
                        }
                    }
                });
                
                infoContent += '</div>';

                const infoWindow = new google.maps.InfoWindow({
                    content: infoContent
                });

                // Add hover listeners (mouseover/mouseout)
                polygon.addListener('mouseover', (event) => {
                    // Close all other info windows
                    this.mapInfoWindows.forEach(iw => iw.close());
                    
                    infoWindow.setPosition(event.latLng);
                    infoWindow.open(this.map);
                });

                polygon.addListener('mouseout', () => {
                    infoWindow.close();
                });

                this.mapPolygons.push(polygon);
                this.mapInfoWindows.push(infoWindow);

                // Extend bounds
                paths.forEach(point => bounds.extend(point));
                hasValidPolygons = true;
            } catch (error) {
                console.warn(`Error displaying feature ${index} on map:`, error);
                // Continue with next feature
            }
        });

        // Fit map to show all polygons (only if we have valid polygons)
        if (hasValidPolygons && this.mapPolygons.length > 0) {
            this.map.fitBounds(bounds, { padding: 50 });
        }
    }

    exportGeoJSON() {
        if (this.features.length === 0) {
            alert('No data to export');
            return;
        }

        // Filter out features with null geometry and clean properties
        const cleanedFeatures = this.features
            .filter(feature => feature.geometry !== null && feature.geometry !== undefined)
            .map(feature => {
                const cleanProps = { ...feature.properties };
                // Remove internal properties
                delete cleanProps._plotId;
                delete cleanProps._missingGeojson;
                delete cleanProps._error;
                delete cleanProps._csvRowIndex;
                
                return {
                    type: 'Feature',
                    geometry: feature.geometry,
                    properties: cleanProps
                };
            });

        if (cleanedFeatures.length === 0) {
            alert('No plots with valid geometry to export. All rows are missing geojson data.');
            return;
        }

        const featureCollection = {
            type: 'FeatureCollection',
            features: cleanedFeatures
        };

        // Convert to JSON string
        const geojsonString = JSON.stringify(featureCollection, null, 2);

        // Create blob and download
        const blob = new Blob([geojsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'goa_cadastral_plots.geojson';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const excludedCount = this.features.length - cleanedFeatures.length;
        let message = `GeoJSON file downloaded successfully! (${cleanedFeatures.length} plots)`;
        if (excludedCount > 0) {
            message += `\n\n${excludedCount} plot(s) without geometry were excluded from export.`;
        }

        console.log('GeoJSON exported successfully');
        alert(message);
    }

    exportKML() {
        if (this.features.length === 0) {
            alert('No data to export');
            return;
        }

        if (typeof tokml === 'undefined') {
            alert('KML converter library not loaded');
            return;
        }

        // Filter out features with null geometry and clean properties
        const cleanedFeatures = this.features
            .filter(feature => feature.geometry !== null && feature.geometry !== undefined)
            .map(feature => {
                const cleanProps = { ...feature.properties };
                // Remove internal properties
                delete cleanProps._plotId;
                delete cleanProps._missingGeojson;
                delete cleanProps._error;
                delete cleanProps._csvRowIndex;
                
                return {
                    type: 'Feature',
                    geometry: feature.geometry,
                    properties: cleanProps
                };
            });

        if (cleanedFeatures.length === 0) {
            alert('No plots with valid geometry to export. All rows are missing geojson data.');
            return;
        }

        const featureCollection = {
            type: 'FeatureCollection',
            features: cleanedFeatures
        };

        // Convert to KML using tokml library
        const kmlString = tokml(featureCollection);

        // Create blob and download
        const blob = new Blob([kmlString], { type: 'application/vnd.google-earth.kml+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'goa_cadastral_plots.kml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const excludedCount = this.features.length - cleanedFeatures.length;
        let message = `KML file downloaded successfully! (${cleanedFeatures.length} plots)`;
        if (excludedCount > 0) {
            message += `\n\n${excludedCount} plot(s) without geometry were excluded from export.`;
        }

        console.log('KML exported successfully');
        alert(message);
    }

    clearAll() {
        // Clear map
        this.mapPolygons.forEach(polygon => polygon.setMap(null));
        this.mapPolygons = [];
        this.mapInfoWindows = [];
        
        // Clear features
        this.features = [];
        this.customProperties = [];
        this.plotIdCounter = 0;
        this.usedKeys.clear();
        this.usedValues.clear();
        this.rowsWithMissingGeojson = [];
        
        // Clear table
        $('#results-table-body').empty();
        $('#results-table-container').hide();
        
        // Hide results section
        $('#results-section').hide();
        
        // Reset file input
        $('#csv-upload').val('');
        $('#csv-status').text('');
        $('#process-csv').prop('disabled', true);
        $('#export-button').prop('disabled', true);
        
        // Reset dropdowns
        $('#village-dropdown').prop('disabled', true).empty().append('<option value="">Select Village</option>');
        $('#survey-dropdown').prop('disabled', true).empty().append('<option value="">Select Survey No (Optional)</option>');
        $('#subdiv-dropdown').prop('disabled', true).empty().append('<option value="">Select Subdiv (Optional)</option>');
        $('#taluka-dropdown').val('');
        $('#add-plot-button').prop('disabled', true);
        
        // Remove datalists
        $('#keys-datalist').remove();
        $('#values-datalist').remove();
        
        console.log('All data cleared');
    }
}

// Initialize app when DOM and Google Maps are ready
let app;
window.addEventListener('load', async () => {
    // Wait for Google Maps to load
    if (window.googleMapsLoaded) {
        app = new ExportApp();
        window.exportApp = app;
    } else {
        window.addEventListener('googlemapsloaded', () => {
            app = new ExportApp();
            window.exportApp = app;
        });
    }
});
